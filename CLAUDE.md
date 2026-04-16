# Fondo Montañez API v2

NestJS rewrite of the Fondo Montañez backend (migrated from Django/Python).

## Stack

- **Framework:** NestJS v11
- **Language:** TypeScript 5 (Node.js >=24)
- **ORM:** Prisma v7 with PostgreSQL (`@prisma/adapter-pg`)
- **Email:** AWS SES
- **Queue:** AWS SQS
- **Storage:** Google Cloud Storage
- **Scheduling:** `@nestjs/schedule`

## Project Structure

```
src/
  auth/           # Authentication (guards, decorators, service)
  users/          # User management
  loans/          # Loan management
  saving-accounts/# Saving account management
  activities/     # Activity tracking
  notifications/  # Notification system
  mail/           # Email via AWS SES
  files/          # File uploads via GCS
  admin/          # Admin operations
  scheduler/      # Cron/scheduled jobs (separate entrypoint)
  prisma/         # Global PrismaService (injected everywhere)
  config/         # App configuration via @nestjs/config
prisma/
  schema.prisma   # DB schema (legacy Django table names: snake_case)
  migrations/
generated/
  prisma/         # Prisma generated client output
test/
  e2e/            # E2E specs per module
```

## Database

Prisma schema reflects the legacy Django database — models use Django-style naming (`auth_user`, `fondo_api_userprofile`, `django_content_type`, etc.). Do not rename these models; they map to an existing PostgreSQL database.

Environment variables required:
```
POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DATABASE
```

## Commands

```bash
npm run start:dev          # Development server (watch mode)
npm run start:scheduler    # Scheduler process (separate entrypoint)
npm run build              # Production build

npm run test:unit          # Unit tests with coverage
npm run test:e2e           # E2E tests (sequential, --runInBand)
npm run test               # Unit + E2E

npm run lint               # ESLint with auto-fix
npm run format             # Prettier
```

## Testing

- **Unit tests:** `*.spec.ts` files co-located in `src/`, run via `jest-unit.json`
- **E2E tests:** `test/e2e/*.e2e-spec.ts`, run via `jest-e2e.json` (30s timeout, sequential)
- TypeScript is strict-null-check disabled (`strictNullChecks: false`, `noImplicitAny: false`)

## Environment Variables

```
PORT                      # Server port (default: 3000)
POSTGRES_*                # Database connection
AWS_REGION
DEFAULT_FROM_EMAIL        # SES sender
NOTIFICATIONS_QUEUE_URL   # SQS queue
HOST_URL_APP              # Frontend URL (used in emails/links)
ENVIRONMENT               # "production" | "development" (default: production)
```

## Conventions

- Each module follows NestJS standard structure: `*.module.ts`, `*.service.ts`, `*.controller.ts`
- `PrismaModule` is global — inject `PrismaService` directly without importing the module
- Configuration accessed via `ConfigService` from `@nestjs/config`
- The scheduler has its own entrypoint (`src/scheduler/scheduler-main.ts`) and can run as a separate process
