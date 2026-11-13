// Explicitly reserved endpoint only; no issuer/credentials/admission exists.
export const LIVE_ENTRY_PATH='/api/owner/parcel2go-live-credentials';
export function assertLiveEntryDisabled(env){if((env.RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY??'disabled/v1')!=='disabled/v1')throw Error('Live credential entry is not implemented; activation refused');}
