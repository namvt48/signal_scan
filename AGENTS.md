# Local development rules

- For local-only testing, login may be bypassed with `VITE_AUTH_DISABLED=1` in the Vite environment and `AUTH_DISABLED=1` in the local API environment. Start both frontend and API with these flags only when running on a developer machine.
- The bypass grants admin access. Never set either flag in production, staging, deployed builds, shared servers, or remote developer environments; those must use Firebase authentication and server-side authorization.
- Verify bypass flags are absent from deployed environment variables before shipping.
- Do not commit local `.env` files or bypass credentials.
- When testing locally, use the existing bypass rather than weakening auth checks or adding test-only bypasses to application code.
