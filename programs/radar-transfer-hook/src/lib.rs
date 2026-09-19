use anchor_lang::prelude::*;

pub mod error;
pub mod state;

use error::RadarHookError;
use state::*;

declare_id!("ASXvQYqhWYz82YFcqHUdcWDNotqt9atTJYp3xDHiV8Qz");

pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
pub const RADAR_CONFIG_SEED: &[u8] = b"radar_config";

#[program]
pub mod radar_transfer_hook {
    use super::*;

    /// Initializes the transfer hook configuration and ExtraAccountMetaList for an SPL Token-22 mint.
    pub fn initialize(
        ctx: Context<Initialize>,
        max_risk_score: u8,
        allow_unverified: bool,
        max_attestation_age_sec: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.max_risk_score = if max_risk_score == 0 { 80 } else { max_risk_score.min(100) };
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
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Err(RadarHookError::InvalidTransferAmount.into());
        }

        let config = &ctx.accounts.config;
        let remaining = ctx.remaining_accounts;

        // Verify destination oracle record if supplied in extra accounts
        if remaining.is_empty() {
            if config.allow_unverified {
                msg!("RadarHook: no oracle account provided; unverified counterparty allowed by config");
                return Ok(());
            } else {
                msg!("RadarHook: transfer rejected; destination has no verified scan record on-chain");
                return Err(RadarHookError::UnverifiedCounterparty.into());
            }
        }

        let oracle_acc = &remaining[0];
        let data = oracle_acc.try_borrow_data()?;

        if data.is_empty() {
            if config.allow_unverified {
                msg!("RadarHook: oracle record empty; allowed by allow_unverified policy");
                return Ok(());
            } else {
                return Err(RadarHookError::UnverifiedCounterparty.into());
            }
        }

        // Parse binary ScanLedgerRecord header ("RS01")
        let header = ScanRecordHeader::try_parse(&data)
            .ok_or(RadarHookError::InvalidScanRecordMagic)?;

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
            if current_ts > header.timestamp && (current_ts - header.timestamp) > config.max_attestation_age_sec {
                msg!("RadarHook: REJECTED - attestation expired (age > {}s)", config.max_attestation_age_sec);
                return Err(RadarHookError::StaleOracleAttestation.into());
            }
        }

        msg!("RadarHook: transfer allowed for amount {}", amount);
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
pub struct TransferHook<'info> {
    /// CHECK: Source token account (checked by Token-22)
    pub source: AccountInfo<'info>,

    /// CHECK: Token mint
    pub mint: AccountInfo<'info>,

    /// CHECK: Destination token account
    pub destination: AccountInfo<'info>,

    /// CHECK: Source account owner or delegate authority
    pub owner: AccountInfo<'info>,

    /// CHECK: ExtraAccountMetaList PDA for the transfer hook
    #[account(
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_metas: AccountInfo<'info>,

    /// Configuration account governing this mint's risk limits
    #[account(
        seeds = [RADAR_CONFIG_SEED, mint.key().as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, RadarHookConfig>,
}
