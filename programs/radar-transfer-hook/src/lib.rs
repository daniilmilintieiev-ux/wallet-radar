use anchor_lang::prelude::*;

pub mod error;
pub mod state;

use error::RadarHookError;
use state::*;
use spl_pod::primitives::PodBool;
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("wvN1kyvjoFSJq5YqaniVRUm9Tay2wADtMGSayAzHwoV");

#[used]
pub static P4_BUILD_MARKER: [u8; 64] = *b"radar-ap1-unique-elf-size-marker-0123456789012345678901234567890";

pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
pub const RADAR_CONFIG_SEED: &[u8] = b"radar_config";
pub const RADAR_RECORD_SEED: &[u8] = b"radar_record";

/// Account size for the ExtraAccountMetaList PDA holding two
/// `ExtraAccountMeta` entries (config + scan-record):
///   get_base_len() [12] + PodSlice header [4] + 2 * ExtraAccountMeta [35] = 86
pub const EXTRA_ACCOUNT_METAS_SPACE: usize = 12 + 4 + 2 * 35;

/// Borsh-serializable mirror of `ExtraAccountMeta` (35 bytes) so meta list
/// entries can be passed as instruction arguments. Entries are passed through
/// verbatim to the on-chain `ExtraAccountMetaList`:
///   discriminator 0 = static account (`address_config` = 32-byte pubkey)
///   discriminator 1 = PDA (`address_config` = packed seed TLV, resolved
///     per transfer — e.g. `radar_record` seed + the destination token
///     account's owner field)
///   discriminator 2 = pubkey data (account/instruction data reference)
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct MetaArg {
    pub discriminator: u8,
    pub address_config: [u8; 32],
    pub is_signer: u8,
    pub is_writable: u8,
}

#[program]
pub mod radar_transfer_hook {
    use super::*;

    /// Initializes the transfer hook configuration for an SPL Token-22 mint.
    pub fn initialize(
        ctx: Context<Initialize>,
        max_risk_score: u8,
        allow_unverified: bool,
        max_attestation_age_sec: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.max_risk_score = if max_risk_score == 0 {
            80
        } else {
            max_risk_score.min(100)
        };
        config.allow_unverified = allow_unverified;
        config.max_attestation_age_sec = max_attestation_age_sec;
        config.bump = ctx.bumps.config;

        msg!(
            "RadarHook: initialized for mint {} (max_risk: {}, allow_unverified: {})",
            config.mint,
            config.max_risk_score,
            config.allow_unverified
        );
        Ok(())
    }

    /// Updates existing risk-gating parameters for a mint.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_max_risk: u8,
        allow_unverified: bool,
        max_attestation_age_sec: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.max_risk_score = new_max_risk.min(100);
        config.allow_unverified = allow_unverified;
        config.max_attestation_age_sec = max_attestation_age_sec;

        msg!(
            "RadarHook: updated config for mint {} (max_risk: {})",
            config.mint,
            config.max_risk_score
        );
        Ok(())
    }

    /// Main transfer hook execution path ("scan-on-transfer").
    /// Invoked on-chain by the SPL Token-22 program on every transfer.
    ///
    /// Account order matches the transfer-hook `execute` interface:
    ///   0 source, 1 mint, 2 destination, 3 authority, 4 validate_state,
    ///   then the additional accounts from the ExtraAccountMetaList
    ///   (5 config PDA, 6 scan-record PDA).
    #[interface(spl_transfer_hook_interface::execute)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Err(RadarHookError::InvalidTransferAmount.into());
        }

        let config = &ctx.accounts.config;

        // Destination owner = owner field of the token account (bytes 32..64).
        let dest_data = ctx.accounts.destination.try_borrow_data()?;
        if dest_data.len() < 64 {
            return Err(RadarHookError::InvalidDestination.into());
        }
        let mut owner_bytes = [0u8; 32];
        owner_bytes.copy_from_slice(&dest_data[32..64]);
        let destination_owner = Pubkey::new_from_array(owner_bytes);
        drop(dest_data);

        // Verify the scan-record PDA is derived from the destination owner.
        let (expected_record, _bump) = Pubkey::find_program_address(
            &[RADAR_RECORD_SEED, destination_owner.as_ref()],
            &crate::ID,
        );
        if ctx.accounts.record.key() != expected_record {
            msg!("RadarHook: REJECTED - scan record PDA does not match destination owner");
            return Err(RadarHookError::RecordPdaMismatch.into());
        }

        let record_data = ctx.accounts.record.try_borrow_data()?;
        let header = match ScanRecordHeader::try_parse(&record_data) {
            Some(h) => h,
            None => {
                // No valid scan attestation on this record account.
                if config.allow_unverified {
                    msg!("RadarHook: allowing unverified destination (empty scan record)");
                    return Ok(());
                }
                msg!("RadarHook: REJECTED - destination has no verified scan record");
                return Err(RadarHookError::UnverifiedCounterparty.into());
            }
        };

        msg!(
            "RadarHook: evaluating destination {} (score: {}, verdict: {}, timestamp: {})",
            header.wallet,
            header.risk_score,
            header.verdict_code,
            header.timestamp
        );

        // 1. Evaluate maximum risk score threshold
        if header.risk_score > config.max_risk_score {
            msg!(
                "RadarHook: REJECTED - risk score {} exceeds maximum allowed {}",
                header.risk_score,
                config.max_risk_score
            );
            return Err(RadarHookError::RiskScoreTooHigh.into());
        }

        // 2. Reject explicit HIGH RISK verdict
        if header.verdict_code == VERDICT_CODE_HIGH_RISK {
            msg!("RadarHook: REJECTED - destination flagged with HIGH RISK verdict");
            return Err(RadarHookError::CounterpartyFlagged.into());
        }

        // 3. Freshness check if configured
        if config.max_attestation_age_sec > 0 {
            let clock = Clock::get()?;
            let current_ts = clock.unix_timestamp as u64;
            if current_ts > header.timestamp
                && (current_ts - header.timestamp) > config.max_attestation_age_sec
            {
                msg!(
                    "RadarHook: REJECTED - attestation expired (age > {}s)",
                    config.max_attestation_age_sec
                );
                return Err(RadarHookError::StaleOracleAttestation.into());
            }
        }

        msg!("RadarHook: transfer allowed for amount {}", amount);
        Ok(())
    }

    /// Initializes the ExtraAccountMetaList PDA for a mint, registering the
    /// additional accounts that the hook receives on every transfer.
    ///
    /// `metas` entries are passed through verbatim (static pubkeys, seed-based
    /// PDAs, or account-data references), so the mint is not locked to a
    /// single destination: a seed entry of the form
    /// `[Literal("radar_record"), AccountData{account 2, data 32..64}]`
    /// resolves the per-transfer scan record from the destination token
    /// account's owner field.
    ///
    /// Account order matches the transfer-hook interface:
    ///   0 extra_account_metas (writable), 1 mint, 2 authority (signer),
    ///   3 system program.
    #[interface(spl_transfer_hook_interface::initialize_extra_account_meta_list)]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
        metas: Vec<MetaArg>,
    ) -> Result<()> {
        if metas.is_empty() {
            return Err(RadarHookError::InvalidExtraMeta.into());
        }
        let extra_metas: Vec<ExtraAccountMeta> = metas
            .iter()
            .map(|m| ExtraAccountMeta {
                discriminator: m.discriminator,
                address_config: m.address_config,
                is_signer: PodBool::from(m.is_signer != 0),
                is_writable: PodBool::from(m.is_writable != 0),
            })
            .collect();

        let data = &mut ctx.accounts.extra_account_metas.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(data, &extra_metas)?;

        msg!(
            "RadarHook: initialized extra-account-metas for mint {} ({} entries)",
            ctx.accounts.mint.key(),
            extra_metas.len()
        );
        Ok(())
    }

    /// Writes a 48-byte scan-record header for a wallet. The record PDA is
    /// derived from the wallet and resolved by the mint's meta list on every
    /// transfer. Only the mint's configured authority may write records.
    pub fn write_scan_record(
        ctx: Context<WriteScanRecord>,
        risk_score: u8,
        verdict_code: u8,
        timestamp: u64,
        payload_len: u16,
    ) -> Result<()> {
        let record = &mut ctx.accounts.record;
        let mut data = record.try_borrow_mut_data()?;

        data[0..4].copy_from_slice(&SCAN_RECORD_MAGIC);
        data[4..36].copy_from_slice(ctx.accounts.wallet.key().as_ref());
        data[36] = risk_score;
        data[37] = verdict_code;
        data[38..46].copy_from_slice(&timestamp.to_le_bytes());
        data[46..48].copy_from_slice(&payload_len.to_le_bytes());

        msg!(
            "RadarHook: wrote scan record for {} (score: {}, verdict: {}, ts: {})",
            ctx.accounts.wallet.key(),
            risk_score,
            verdict_code,
            timestamp
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = RadarHookConfig::LEN,
        seeds = [RADAR_CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, RadarHookConfig>,

    /// CHECK: Token-22 mint account
    pub mint: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [RADAR_CONFIG_SEED, config.mint.as_ref()],
        bump = config.bump,
        has_one = authority @ RadarHookError::Unauthorized
    )]
    pub config: Account<'info, RadarHookConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: Source token account (checked by Token-22)
    pub source: AccountInfo<'info>,

    /// CHECK: Token mint
    pub mint: AccountInfo<'info>,

    /// CHECK: Destination token account
    pub destination: AccountInfo<'info>,

    /// CHECK: Source account owner or delegate authority
    pub authority: AccountInfo<'info>,

    /// CHECK: ExtraAccountMetaList PDA for the transfer hook
    #[account(seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()], bump)]
    pub validate_state: AccountInfo<'info>,

    /// Configuration account governing this mint's risk limits
    #[account(
        seeds = [RADAR_CONFIG_SEED, mint.key().as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, RadarHookConfig>,

    /// CHECK: Destination scan-record PDA (derived from destination owner)
    pub record: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(
        init,
        payer = authority,
        space = EXTRA_ACCOUNT_METAS_SPACE,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_metas: UncheckedAccount<'info>,

    /// CHECK: Token-22 mint account
    pub mint: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteScanRecord<'info> {
    /// CHECK: Counterparty wallet (used as PDA seed)
    pub wallet: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = ScanRecordHeader::HEADER_LEN,
        seeds = [RADAR_RECORD_SEED, wallet.key().as_ref()],
        bump
    )]
    pub record: UncheckedAccount<'info>,

    /// Only the mint's configured authority may write scan records
    #[account(
        seeds = [RADAR_CONFIG_SEED, mint.key().as_ref()],
        bump = config.bump,
        has_one = authority @ RadarHookError::Unauthorized
    )]
    pub config: Account<'info, RadarHookConfig>,

    /// CHECK: Token-22 mint (identifies the config PDA)
    pub mint: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
