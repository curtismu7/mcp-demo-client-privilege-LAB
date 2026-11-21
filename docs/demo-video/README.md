# CIMD real sign-in demo

`cimd-real-signin-demo.mp4` — a real (not simulated) sign-in through the Privilege gateway using
Client ID Metadata Documents (CIMD, IETF draft-ietf-oauth-client-id-metadata-document), with no
Dynamic Client Registration. Recorded with `privilege-cimd-test/video/take.py`.

The run ends with the gateway refusing the agent's tools call (a Privilege authorization policy
gap, unrelated to CIMD) rather than a full success — the CIMD sign-in and token exchange
themselves complete correctly.
