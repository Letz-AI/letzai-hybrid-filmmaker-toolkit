# Security

The kit runs on your own computer. Its server listens on `127.0.0.1` only and needs a random key from the launch link for every request, so other computers and other websites cannot talk to it. API keys are stored in your user settings folder, never in the film folder, and are only sent to the service they belong to (LetzAI, Anthropic, OpenAI or Google).

## Reporting a problem

If you find a security problem, please **do not open a public issue**. Email [support@letz.ai](mailto:support@letz.ai) with "Security" in the subject, what you found and how to reproduce it. You can also use GitHub's private vulnerability reporting on this repository, if it is enabled.

The kit is in beta, so fixes go into the latest version on `main`.
