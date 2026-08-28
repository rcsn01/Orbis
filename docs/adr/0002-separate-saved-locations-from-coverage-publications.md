# ADR-0002: Separate saved locations from coverage publications

- Status: Accepted
- Date: 2026-08-28

## Context

Orbis previously retained one `current.json` manifest and one published SQLite index. Saving another location replaced that manifest even when an existing ancestor publication already contained the requested directory.

A descendant cannot safely become a standalone index by copying its rows. Hard-link representatives, allocated-byte ownership, directory aggregates, exclusions, and the FSEvents cursor are defined across the publication root. A copied slice could omit an owner outside the child or count one allocation in two indexes.

Adding an ancestor has the opposite limitation: a child publication has no rows for the new parent or its siblings. It cannot be expanded into an exact ancestor result without traversing the ancestor.

## Decision

Store a private, atomic `indexes/locations.json` catalog with separate records for:

- **saved locations**, which are user-visible logical roots identified in renderer payloads by opaque IDs;
- **coverage publications**, which are immutable SQLite indexes and retain their own target identity, accounting domain, revision, and journal cursor;
- at most one **pending scan**, matching the singleton Resume descriptor.

A saved descendant may reference an ancestor publication when that publication contains a directory row with the same device and inode. A boundary-restricted location view clips navigation and reveal operations to that logical root. It reads the publication's existing aggregates without copying or reinterpreting them.

Adding an ancestor or an uncovered/disjoint location performs a full scan. Existing publications remain authoritative until the candidate validates and one catalog transaction repoints every location actually covered by it. Only then may unreferenced publications be deleted.

Refresh always runs at the coverage publication root. Descendant aliases share its exclusion policy, hard-link accounting domain, and FSEvents cursor.

Filesystem paths remain private to main/worker state. Snapshot version 4 exposes only location IDs, display names, and `direct`, `ancestor`, or `none` coverage markers.

## Consequences

- One immutable publication can serve several saved locations.
- Adding a covered descendant starts no worker and creates no database.
- Removing a visible ancestor does not invalidate descendants while they still reference its publication.
- A shared descendant's byte total is exact within the ancestor publication's accounting domain; it is not presented as an independently scanned subtree total.
- Adding an ancestor still requires traversal, but publication remains all-or-nothing and old child results survive failure.
- Orbis continues to support only one active or resumable scan. Multiple Resume descriptors are outside this decision.
- `current.json` is read only for one-time migration. `locations.json` becomes the publication commit point.

## Rejected alternatives

### Copy descendant rows

Rejected because it breaks hard-link ownership and aggregate locality and creates redundant artifacts.

### Mutable global forest database

Rejected because it would widen scanner, recovery, journal, and corruption boundaries and discard immutable publication commits.

### One publication per saved location

Rejected because it forces needless descendant rescans and duplicates data already represented by an ancestor publication.
