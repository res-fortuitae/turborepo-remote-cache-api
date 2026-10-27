# Dependency patches

`alchemy@2.0.0-beta.83.patch` serializes local Secrets Store gateway operations
with one Effect semaphore. The beta provider starts concurrent secret
writes against the same gateway name; overlapping scoped gateways can
interrupt another operation and fail its write with `Network connection
lost.` The store binding and persistent storage identity stay unchanged.

The patch changes both Bun's TypeScript entry and the published JavaScript
entry. Upstream source, notices, and licenses remain in the installed package.
Remove the patch when Alchemy fixes concurrent gateway ownership upstream and
`bun run test:stack` passes without it. The local stack suite exercises concurrent
signing/auth secret creation followed by authentication through the real Worker.
