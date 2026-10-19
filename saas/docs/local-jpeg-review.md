# Local JPEG review drafts

An owner can attach an existing JPEG to the exact saved campaign caption and
Page/Instagram destination, save a local review draft and reopen its retained
bytes. This creates no approval, connection write, dispatch claim, provider job
or post. Missing costs remain explicit blockers; no cost is synthesized.

## Storage and activation boundary

Default and production composition keep this feature closed. There is no
environment or HTTP activation switch. A trusted local composition must create
`createLocalDraftStorage({ store, root, environment: 'local' })` using the real
FileStore and pass that opaque object as `localDraftStorage` to
`createPacksmartServer`. The dedicated absolute root must be outside static
application directories and outside symlink/junction paths. Production and
Supabase composition refuse the capability. This is not production storage.

Use an isolated state file with only this version's cooperating FileStore
writers. Every current FileStore save and local draft commit uses the same
exclusive OS-visible lock. This is not a fleet fence: older binaries and tools
that directly rewrite JSON do not participate. Never share this local state
directory with an old server. Older executors cannot discover these drafts
because drafts never enter workspace JSON or any executable queue.

The storage root is bound to one canonical state-file path. Opaque names derive
from tenant identity and request ID, never uploaded filenames or client paths.
Exclusive staging files are flushed before one directory rename exposes a
complete immutable draft. Identical retries return the retained result; a
changed request conflicts. Hashes are verified on reads. Symlink/junction roots,
hard-linked files, substitutions and missing/corrupt bytes are refused. These
integrity checks do not protect against an administrator who can rewrite the
entire private local store and its checksums.

The global cap is 128 entries, including failed staging directories, each with
at most a 2 MiB image and a 64 KiB manifest. Orphans are deliberately not deleted
automatically. A crashed FileStore writer leaves its `.transaction-lock` closed;
recovery requires all local writers to be stopped before an operator examines
that lock. There is no automatic stale-lock stealing or provider retry.

## JPEG contract

Intake accepts only 1080 × 1080 baseline 8-bit, three-component YCbCr JFIF JPEGs
up to 2 MiB. Sampling may be 4:4:4, 4:2:2 or 4:2:0. There is one interleaved scan,
no restart markers, thumbnails, EXIF/ICC/Adobe metadata, comments, progressive
frames, extra scans or trailing bytes. Unsupported files are refused without
conversion. Existing PNG snapshot behavior is unchanged and separate.

An independent structural/entropy parser verifies tables, component identities,
every expected block, coefficient bounds, pad bits and exact end marker.
Pinned `jpeg-js@0.4.4` then decodes all pixels in a bounded worker, with strict
mode, 1.2 MP / 48 MiB decoder accounting, a worker heap bound and a five-second
timeout. At most two decoders run in a process. The manifest retains the exact
encoded SHA-256, byte count, dimensions, decoded RGBA SHA-256 and decoder
contract. Worker heap limits are not a whole-process RSS guarantee.

## Owner workflow and limitations

The owner explicitly chooses a retained destination and local JPEG. The source
revision binds exact caption, product, variant, costs, settings and target.
Fresh owner/session checks surround decoding and disk operations. Source
changes reject new saves; saved drafts remain readable with stale/unavailable
blockers after source removal. Reads never confer publication authority.

After an uncertain response, the UI freezes the exact request body for an
explicit retry. It retains only an opaque request reference in session storage,
scoped by workspace/user/campaign, and can reopen it after reload even if the
campaign has disappeared. Reopen controls retrieve bytes through authenticated
same-origin endpoints; local filesystem paths and credential fields are never
returned. The browser reference is not a cross-device history service.

This image is an owner upload associated with the campaign. It is not proven to
be the bytes of a Canva export. Provider-readable immutable hosting, ownership,
actual provider asset delivery, account/scopes, hosted persistence, fleet
acceptance and exact live-operation approval remain separate closed gates.
