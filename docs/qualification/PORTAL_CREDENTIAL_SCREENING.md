# Portal credential screening policy

This is a bounded privacy screen, not token validation or a guarantee that
arbitrary text is secret-free. Identifiable credentials are never queried
against an external service. Only generated inert strings appear in tests.

Opaque IDs must survive unchanged or be omitted with a warning; never create a
redacted/truncated alias. Prefix recognition is independent of word boundaries
so underscores in identities or display labels cannot hide a known credential.
Native device tokens, OpenAI-style keys, classic/fine-grained/stateless GitHub
tokens, Supabase project/management keys, Stripe secret/restricted keys, AWS
long-term/temporary access IDs, npm/PyPI publication tokens and compact JWT-like
strings are screened. Prefix patterns use conservative minimum lengths, not
provider authentication validity rules. Public sb_publishable_ keys and normal
long identities remain admissible. False-positive credential-like IDs are
omitted rather than altered; local memory remains authoritative.

The source/event hash allowlist and authority do not change. Pattern screening
cannot establish that every arbitrary password, encoded value, unknown format
or unprefixed random string is safe. It does not replace repository secret
scanning, source isolation, operational key management or tenant enforcement.

Primary format references consulted2026-09-23:

- Native device: src/portal-client.mjs validateToken; Portal ingest and private-engine-entitlement authentication contracts.
- GitHub token prefixes and 2026 stateless installation format: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github
- Supabase project keys/JWT distinction: https://supabase.com/docs/guides/getting-started/api-keys
- Supabase management tokens: https://supabase.com/docs/reference/cli/supabase-db-schema-declarative and https://github.com/supabase/jit-db-gatekeeper/blob/main/authenticator.go
- AWS credential ID families: https://docs.aws.amazon.com/STS/latest/APIReference/API_GetAccessKeyInfo.html
- Stripe secret/restricted keys: https://docs.stripe.com/keys and https://docs.stripe.com/api/authentication
- npm prefixed publication tokens: https://api-docs.npmjs.com/
- PyPI token detector format: https://docs.pypi.org/api/secrets/
- Supabase authentication JWTs: https://supabase.com/docs/guides/auth/jwts

Regression matrix tests every added family in exact IDs and the producer's
display text; Portal rejects corresponding wire values. The first matrix
recorded18 missed identity/label cases across9 families before extension.
The completed matrix also includes both Supabase management token prefixes.
The source list documents formats; the safety policy deliberately does not
require a provider token to be active, valid or checksum-correct to redact it.
