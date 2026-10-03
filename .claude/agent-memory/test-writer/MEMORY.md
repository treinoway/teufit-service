# Test Writer Memory Index

- [Unit test mock patterns](patterns-unit-mocks.md) — Prisma mock structure, beforeEach defaults, toEqual shape pinning
- [E2E test patterns](patterns-e2e.md) — app bootstrap, cleanDatabase, auth helpers, TrainerStudent setup
- [Pre-existing E2E failures](known-failures.md) — E2E files with pre-existing failures; getConversation API limitations
- [AI service test patterns](patterns-ai-service.md) — mock structure for studentDashboardService, executeTool patterns, first-turn enforcement
- [Intensity field patterns](patterns-intensity.md) — validateIntensityRequiresCardio mock patterns, dual-check in update, effectiveType/effectiveIntensity logic
- [Config-driven test-env defaults (betaInviteGate)](patterns-config-gate.md) — test env defaults the gate OFF; tests exercising the gate-enabled path must force it on and restore it
- [Student invite / email verification patterns](patterns-student-invite.md) — capture codes via spy, cooldown backdating, single-file e2e command
