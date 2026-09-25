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

/// Maximum allowable clock drift into the future for attestation timestamps (60 seconds).
/// Accounts for Solana Clock sysvar slot calculation lag relative to real-world UTC.
pub const MAX_FUTURE_DRIFT_SEC: u64 = 60;

/// Account size for the ExtraAccountMetaList PDA holding extra
/// `ExtraAccountMeta` entries (config + scan-record + source scan-record):
///   get_base_len() [12] + PodSlice header [4] + 3 * ExtraAccountMeta [35] = 121
pub const EXTRA_ACCOUNT_METAS_SPACE: usize = 12 + 4 + 3 * 35;

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
        // Bug 1: Verify authority matches mint_authority to prevent front-running/hijacking
        let mint_info = &ctx.accounts.mint;
        let mut is_authorized = false;
        if mint_info.data_len() >= 36 {
            let mint_data = mint_info.try_borrow_data()?;
            let coption_tag = u32::from_le_bytes(mint_data[0..4].try_into().unwrap());
            if coption_tag == 1 {
                let mint_auth = Pubkey::new_from_array(mint_data[4..36].try_into().unwrap());
                if mint_auth == ctx.accounts.authority.key() {
                    is_authorized = true;
                }
            }
        }
        require!(is_authorized, RadarHookError::Unauthorized);

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

    /// Sets a new authority for the mint's transfer hook configuration (Audit 1.4).
    pub fn set_authority(ctx: Context<UpdateConfig>, new_authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let old_authority = config.authority;
        config.authority = new_authority;

        msg!(
            "RadarHook: authority rotated from {} to {} for mint {}",
            old_authority,
            new_authority,
            config.mint
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

        // Audit 1.5 & 2.2: Two-sided counterparty check (evaluate sender risk and prevent bypass)
        let source_data = ctx.accounts.source.try_borrow_data()?;
        if source_data.len() >= 64 {
            let mut src_owner_bytes = [0u8; 32];
            src_owner_bytes.copy_from_slice(&source_data[32..64]);
            let source_owner = Pubkey::new_from_array(src_owner_bytes);
            drop(source_data);

            let (expected_src_record, _src_bump) = Pubkey::find_program_address(
                &[
                    RADAR_RECORD_SEED,
                    ctx.accounts.mint.key().as_ref(),
                    source_owner.as_ref(),
                ],
                &crate::ID,
            );

            let mut found_src_record = false;
            for account in ctx.remaining_accounts.iter() {
                if account.key() == expected_src_record {
                    if let Ok(src_data) = account.try_borrow_data() {
                        if let Some(src_header) = ScanRecordHeader::try_parse(&src_data) {
                            found_src_record = true;
                            if src_header.risk_score > config.max_risk_score {
                                msg!(
                                    "RadarHook: REJECTED - source owner {} risk score {} exceeds maximum allowed {}",
                                    source_owner,
                                    src_header.risk_score,
                                    config.max_risk_score
                                );
                                return Err(RadarHookError::RiskScoreTooHigh.into());
                            }
                            if src_header.verdict_code == VERDICT_CODE_HIGH_RISK {
                                msg!(
                                    "RadarHook: REJECTED - source owner {} flagged with HIGH RISK verdict",
                                    source_owner
                                );
                                return Err(RadarHookError::CounterpartyFlagged.into());
                            }
                            if config.max_attestation_age_sec > 0 {
                                let clock = Clock::get()?;
                                let current_ts = clock.unix_timestamp as u64;
                                if src_header.timestamp > current_ts.saturating_add(MAX_FUTURE_DRIFT_SEC)
                                    || (current_ts > src_header.timestamp
                                        && (current_ts - src_header.timestamp) > config.max_attestation_age_sec)
                                {
                                    msg!(
                                        "RadarHook: REJECTED - source attestation expired or future timestamp",
                                    );
                                    return Err(RadarHookError::StaleOracleAttestation.into());
                                }
                            }
                        }
                    }
                }
            }

            if !found_src_record && !config.allow_unverified {
                msg!("RadarHook: REJECTED - source {} has no verified scan record", source_owner);
                return Err(RadarHookError::UnverifiedCounterparty.into());
            }
        }

        // Destination owner = owner field of the token account (bytes 32..64).
        let dest_data = ctx.accounts.destination.try_borrow_data()?;
        if dest_data.len() < 64 {
            return Err(RadarHookError::InvalidDestination.into());
        }
        let mut owner_bytes = [0u8; 32];
        owner_bytes.copy_from_slice(&dest_data[32..64]);
        let destination_owner = Pubkey::new_from_array(owner_bytes);
        drop(dest_data);

        // Verify the scan-record PDA is derived from the mint and the destination owner.
        let (expected_record, _bump) = Pubkey::find_program_address(
            &[
                RADAR_RECORD_SEED,
                ctx.accounts.mint.key().as_ref(),
                destination_owner.as_ref(),
            ],
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
            if header.timestamp > current_ts.saturating_add(MAX_FUTURE_DRIFT_SEC)
                || (current_ts > header.timestamp
                    && (current_ts - header.timestamp) > config.max_attestation_age_sec)
            {
                msg!(
                    "RadarHook: REJECTED - attestation expired or future timestamp",
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

        // Audit 1.1: Verify authority to prevent unauthorized initialization and DoS.
        // The authority must match either the mint's mint_authority or the RadarHookConfig authority.
        let mut is_authorized = false;
        let mint_info = &ctx.accounts.mint;
        if mint_info.data_len() >= 36 {
            let mint_data = mint_info.try_borrow_data()?;
            let coption_tag = u32::from_le_bytes(mint_data[0..4].try_into().unwrap());
            if coption_tag == 1 {
                let mint_auth = Pubkey::new_from_array(mint_data[4..36].try_into().unwrap());
                if mint_auth == ctx.accounts.authority.key() {
                    is_authorized = true;
                }
            }
        }
        if !is_authorized {
            let (expected_config, _) = Pubkey::find_program_address(
                &[RADAR_CONFIG_SEED, ctx.accounts.mint.key().as_ref()],
                &crate::ID,
            );
            for account in ctx.remaining_accounts.iter() {
                if account.key() == expected_config {
                    let mut data: &[u8] = &account.try_borrow_data()?;
                    if let Ok(config) = RadarHookConfig::try_deserialize(&mut data) {
                        if config.authority == ctx.accounts.authority.key() {
                            is_authorized = true;
                            break;
                        }
                    }
                }
            }
        }
        require!(is_authorized, RadarHookError::Unauthorized);

        let extra_metas: Vec<ExtraAccountMeta> = metas
            .iter()
            .map(|m| ExtraAccountMeta {
                discriminator: m.discriminator,
                address_config: m.address_config,
                is_signer: PodBool::from(m.is_signer != 0),
                is_writable: PodBool::from(m.is_writable != 0),
            })
            .collect();

        let meta_info = ctx.accounts.extra_account_metas.to_account_info();
        if meta_info.owner == &anchor_lang::system_program::ID {
            let mint_key = ctx.accounts.mint.key();
            let bump = ctx.bumps.extra_account_metas;
            let signer_seeds: &[&[&[u8]]] = &[&[
                EXTRA_ACCOUNT_METAS_SEED,
                mint_key.as_ref(),
                &[bump],
            ]];

            let alloc_space = EXTRA_ACCOUNT_METAS_SPACE.max(12 + 4 + metas.len() * 35);
            let rent = Rent::get()?;
            let required_lamports = rent.minimum_balance(alloc_space);
            let current_lamports = meta_info.lamports();

            if current_lamports < required_lamports {
                let diff = required_lamports.saturating_sub(current_lamports);
                anchor_lang::solana_program::program::invoke(
                    &anchor_lang::solana_program::system_instruction::transfer(
                        &ctx.accounts.authority.key(),
                        &meta_info.key(),
                        diff,
                    ),
                    &[
                        ctx.accounts.authority.to_account_info(),
                        meta_info.clone(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;
            }

            anchor_lang::solana_program::program::invoke_signed(
                &anchor_lang::solana_program::system_instruction::allocate(
                    &meta_info.key(),
                    alloc_space as u64,
                ),
                &[
                    meta_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                signer_seeds,
            )?;

            anchor_lang::solana_program::program::invoke_signed(
                &anchor_lang::solana_program::system_instruction::assign(
                    &meta_info.key(),
                    &crate::ID,
                ),
                &[
                    meta_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                signer_seeds,
            )?;
        }

        let mut data = meta_info.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &extra_metas)?;

        msg!(
            "RadarHook: initialized extra-account-metas for mint {} ({} entries)",
            ctx.accounts.mint.key(),
            extra_metas.len()
        );
        Ok(())
    }

    /// Updates an existing ExtraAccountMetaList PDA for a mint (Audit Revision 11 WR-HIGH-02).
    /// Plain Anchor discriminator: anchor 0.30.1's `#[interface]` macro only knows
    /// `execute` and `initialize_extra_account_meta_list`, so the sighash is
    /// sha256("global:update_extra_account_meta_list")[0..8].
    pub fn update_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
        metas: Vec<MetaArg>,
    ) -> Result<()> {
        if metas.is_empty() {
            return Err(RadarHookError::InvalidExtraMeta.into());
        }

        // Verify authority to prevent unauthorized updates.
        // The authority must match either the mint's mint_authority or the RadarHookConfig authority.
        let mut is_authorized = false;
        let mint_info = &ctx.accounts.mint;
        if mint_info.data_len() >= 36 {
            let mint_data = mint_info.try_borrow_data()?;
            let coption_tag = u32::from_le_bytes(mint_data[0..4].try_into().unwrap());
            if coption_tag == 1 {
                let mint_auth = Pubkey::new_from_array(mint_data[4..36].try_into().unwrap());
                if mint_auth == ctx.accounts.authority.key() {
                    is_authorized = true;
                }
            }
        }
        if !is_authorized {
            let (expected_config, _) = Pubkey::find_program_address(
                &[RADAR_CONFIG_SEED, ctx.accounts.mint.key().as_ref()],
                &crate::ID,
            );
            for account in ctx.remaining_accounts.iter() {
                if account.key() == expected_config {
                    let mut data: &[u8] = &account.try_borrow_data()?;
                    if let Ok(config) = RadarHookConfig::try_deserialize(&mut data) {
                        if config.authority == ctx.accounts.authority.key() {
                            is_authorized = true;
                            break;
                        }
                    }
                }
            }
        }
        require!(is_authorized, RadarHookError::Unauthorized);

        let extra_metas: Vec<ExtraAccountMeta> = metas
            .iter()
            .map(|m| ExtraAccountMeta {
                discriminator: m.discriminator,
                address_config: m.address_config,
                is_signer: PodBool::from(m.is_signer != 0),
                is_writable: PodBool::from(m.is_writable != 0),
            })
            .collect();

        let meta_info = ctx.accounts.extra_account_metas.to_account_info();
        let mut data = meta_info.try_borrow_mut_data()?;
        ExtraAccountMetaList::update::<ExecuteInstruction>(&mut data, &extra_metas)?;

        msg!(
            "RadarHook: updated extra-account-metas for mint {} ({} entries)",
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
        let record_info = ctx.accounts.record.to_account_info();

        // Audit 1.1 (DoS / 1-lamport PDA lock fix):
        // If the account is uninitialized (owned by SystemProgram), allocate and assign it
        // using PDA signer seeds. This gracefully handles pre-funded lamports without falling
        // into Anchor's `init_if_needed` unchecked lamports == 0 trap.
        if record_info.owner == &anchor_lang::system_program::ID {
            let mint_key = ctx.accounts.mint.key();
            let wallet_key = ctx.accounts.wallet.key();
            let bump = ctx.bumps.record;
            let signer_seeds: &[&[&[u8]]] = &[&[
                RADAR_RECORD_SEED,
                mint_key.as_ref(),
                wallet_key.as_ref(),
                &[bump],
            ]];

            let rent = Rent::get()?;
            let required_lamports = rent.minimum_balance(ScanRecordHeader::HEADER_LEN);
            let current_lamports = record_info.lamports();

            if current_lamports < required_lamports {
                let diff = required_lamports.saturating_sub(current_lamports);
                anchor_lang::solana_program::program::invoke(
                    &anchor_lang::solana_program::system_instruction::transfer(
                        &ctx.accounts.authority.key(),
                        &record_info.key(),
                        diff,
                    ),
                    &[
                        ctx.accounts.authority.to_account_info(),
                        record_info.clone(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;
            }

            anchor_lang::solana_program::program::invoke_signed(
                &anchor_lang::solana_program::system_instruction::allocate(
                    &record_info.key(),
                    ScanRecordHeader::HEADER_LEN as u64,
                ),
                &[
                    record_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                signer_seeds,
            )?;

            anchor_lang::solana_program::program::invoke_signed(
                &anchor_lang::solana_program::system_instruction::assign(
                    &record_info.key(),
                    &crate::ID,
                ),
                &[
                    record_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                signer_seeds,
            )?;
        } else if record_info.owner != &crate::ID {
            return Err(ProgramError::IllegalOwner.into());
        }

        let mut data = record_info.try_borrow_mut_data()?;
        if data.len() < ScanRecordHeader::HEADER_LEN {
            return Err(ProgramError::AccountDataTooSmall.into());
        }

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

    /// Closes an existing scan record PDA and refunds rent lamports back to authority (Audit 3.5).
    pub fn close_scan_record(ctx: Context<CloseScanRecord>) -> Result<()> {
        let record_info = ctx.accounts.record.to_account_info();
        let authority_info = ctx.accounts.authority.to_account_info();

        // Bug 4: Require record to be owned by this program before attempting to close
        require!(
            record_info.owner == &crate::ID,
            RadarHookError::InvalidAccountOwner
        );

        let record_lamports = record_info.lamports();
        **record_info.try_borrow_mut_lamports()? = 0;
        **authority_info.try_borrow_mut_lamports()? = authority_info
            .lamports()
            .checked_add(record_lamports)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        record_info.realloc(0, false)?;
        record_info.assign(&anchor_lang::system_program::ID);

        msg!(
            "RadarHook: closed scan record for {} and refunded {} lamports to authority {}",
            ctx.accounts.wallet.key(),
            record_lamports,
            ctx.accounts.authority.key()
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
        mut,
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
        mut,
        seeds = [RADAR_RECORD_SEED, mint.key().as_ref(), wallet.key().as_ref()],
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

#[derive(Accounts)]
pub struct CloseScanRecord<'info> {
    /// CHECK: Counterparty wallet (used as PDA seed)
    pub wallet: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [RADAR_RECORD_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub record: UncheckedAccount<'info>,

    /// Only the mint's configured authority may close scan records
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
}
