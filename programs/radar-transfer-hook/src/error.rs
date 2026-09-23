use anchor_lang::prelude::*;

#[error_code(offset = 0)]
pub enum RadarHookError {
    #[msg("Destination wallet risk score exceeds maximum allowed threshold")]
    RiskScoreTooHigh = 6000,

    #[msg("Destination wallet is flagged with HIGH RISK verdict on-chain")]
    CounterpartyFlagged = 6001,

    #[msg("Destination wallet oracle scan attestation is stale")]
    StaleOracleAttestation = 6002,

    #[msg("Destination wallet has no on-chain scan attestation")]
    UnverifiedCounterparty = 6003,

    #[msg("Invalid oracle scan record header magic")]
    InvalidScanRecordMagic = 6004,

    #[msg("Unauthorized: signer does not match authority")]
    Unauthorized = 6005,

    #[msg("Transfer amount is zero or invalid")]
    InvalidTransferAmount = 6006,

    #[msg("Missing expected destination oracle record account")]
    MissingOracleAccount = 6007,

    #[msg("Invalid extra-account-meta entry")]
    InvalidExtraMeta = 6008,

    #[msg("Scan-record PDA does not match destination owner")]
    RecordPdaMismatch = 6009,

    #[msg("Destination token account is too small to read owner")]
    InvalidDestination = 6010,
}
