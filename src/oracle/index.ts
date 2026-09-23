/**
 * On-chain ZK-compressed scan ledger oracle module.
 */

export {
  type ScanLedgerRecord,
  type CommitScanOptions,
  type CommitScanResult,
  type ReadScanLedgerOptions,
  type ZKOracleClient,
  type LightZKOracleClientOptions,
  DEFAULT_ORACLE_PROGRAM_ID,
  SCAN_RECORD_MAGIC,
  VERDICT_CODE_MAP,
  CODE_VERDICT_MAP,
  ORACLE_ATTESTATION_DOMAIN,
  walletToHash32,
  buildAttestationDigest,
  signAttestation,
  verifyAttestation,
  serializeScanRecord,
  deserializeScanRecord,
  MockZKOracleClient,
  LightZKOracleClient,
  loadPayerFromEnv,
  commitScan,
  readScanLedger,
} from "./ledger.js";
