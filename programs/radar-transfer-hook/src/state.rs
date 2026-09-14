use anchor_lang::prelude::*;

/// Magic 4-byte header identifying valid binary scan ledger records ("RS01")
pub const SCAN_RECORD_MAGIC: [u8; 4] = [0x52, 0x53, 0x30, 0x31];

/// Verdict codes mapping to Wallet Radar verdicts
pub const VERDICT_CODE_SAFE: u8 = 0;
pub const VERDICT_CODE_LOW_RISK: u8 = 1;
pub const VERDICT_CODE_SUSPICIOUS: u8 = 2;
pub const VERDICT_CODE_HIGH_RISK: u8 = 3;

/// Global or mint-level configuration for the transfer hook
#[account]
#[derive(Default)]
pub struct RadarHookConfig {
    /// Authority allowed to update settings
    pub authority: Pubkey,
    /// Associated token mint
    pub mint: Pubkey,
    /// Maximum allowed destination risk score (0..100). Default: 80
    pub max_risk_score: u8,
    /// Whether to allow transfers to counterparties with no on-chain scan record
    pub allow_unverified: bool,
    /// Maximum allowed attestation age in seconds (0 = disabled)
    pub max_attestation_age_sec: u64,
    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl RadarHookConfig {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        32 + // mint
        1 +  // max_risk_score
        1 +  // allow_unverified
        8 +  // max_attestation_age_sec
        1;   // bump
}

/// Zero-copy view into the 48-byte header of a ScanLedgerRecord account
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanRecordHeader {
    pub wallet: Pubkey,
    pub risk_score: u8,
    pub verdict_code: u8,
    pub timestamp: u64,
    pub payload_len: u16,
}

impl ScanRecordHeader {
    pub const HEADER_LEN: usize = 48;

    /// Parses the fixed header from account data bytes.
    pub fn try_parse(data: &[u8]) -> Option<Self> {
        if data.len() < Self::HEADER_LEN {
            return None;
        }

        // Verify magic bytes: "RS01"
        if data[0..4] != SCAN_RECORD_MAGIC {
            return None;
        }

        let mut wallet_bytes = [0u8; 32];
        wallet_bytes.copy_from_slice(&data[4..36]);
        let wallet = Pubkey::new_from_array(wallet_bytes);

        let risk_score = data[36];
        let verdict_code = data[37];

        let mut ts_bytes = [0u8; 8];
        ts_bytes.copy_from_slice(&data[38..46]);
        let timestamp = u64::from_le_bytes(ts_bytes);

        let mut len_bytes = [0u8; 2];
        len_bytes.copy_from_slice(&data[46..48]);
        let payload_len = u16::from_le_bytes(len_bytes);

        Some(Self {
            wallet,
            risk_score,
            verdict_code,
            timestamp,
            payload_len,
        })
    }
}
