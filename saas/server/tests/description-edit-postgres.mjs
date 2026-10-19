// The same full historical consumer suite runs after the prepared forward SQL.
// Its existing disposable database identity checks and cleanup remain mandatory.
process.env.RUNVARA_DESCRIPTION_UPGRADE_PROOF = '1';
await import('./receipt-outcome-consumer-postgres.mjs');
