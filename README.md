# Treinoway Service

Backend API for Treinoway - A wellness and training platform.

## 🚀 Tech Stack

- **Runtime**: Node.js 24+
- **Framework**: Fastify
- **Database**: PostgreSQL 17 (Alpine)
- **ORM**: Prisma 7
- **Container**: Docker Compose

## 📋 Prerequisites

Before you begin, ensure you have installed:

- [Node.js](https://nodejs.org/) (v24.x or higher)
- [Docker](https://www.docker.com/) and Docker Compose
- [Git](https://git-scm.com/)

## 🛠️ Quick Start (Development)

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd treinoway-service
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and add your Google OAuth credentials:

```env
# Server Configuration
PORT=3000
HOST=0.0.0.0

# Database Configuration
DATABASE_URL="local_db_url"

# Google OAuth Configuration
GOOGLE_OAUTH_CLIENT_ID=your_google_client_id_here
GOOGLE_OAUTH_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_OAUTH_CALLBACK_URL=http://localhost:3000/auth/google/callback

# Session Secret (change this to a random string)
SESSION_SECRET=your-random-secret-key-here

# Frontend URL to redirect after successful OAuth (backend-for-frontend pattern)
# Example:
# FRONTEND_REDIRECT_URL=http://localhost:5173/auth/callback

```

### 4. Start PostgreSQL Database

```bash
npm run db:start
```

Wait a few seconds for the database to initialize.

### 5. Run Database Migrations

```bash
npm run db:migrate
```

This will:
- Create the database schema
- Generate Prisma Client

### 6. Start Development Server

```bash
npm run dev
```

The server will start on **http://localhost:3000**

## 🎯 Available Scripts

| Command | Description |
|---------|-------------|
| `npm run setup` | **One-command setup**: Install deps, start DB, migrate, generate client |
| `npm run dev` | Start development server with hot reload |
| `npm start` | Start production server |
| `npm run db:start` | Start PostgreSQL container |
| `npm run db:stop` | Stop PostgreSQL container |
| `npm run db:reset` | Reset database (⚠️ deletes all data) |
| `npm run db:migrate` | Run database migrations |
| `npm run db:generate` | Generate Prisma Client |
| `npm run db:studio` | Open Prisma Studio (database GUI) |

## 🔐 Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable **Google+ API**
4. Go to **APIs & Services** → **OAuth consent screen**
   - Choose **External**
   - Fill in app name and contact email
5. Go to **APIs & Services** → **Credentials**
6. Click **Create Credentials** → **OAuth client ID**
7. Choose **Web application**
8. Add authorized redirect URIs:
   - `http://localhost:3000/auth/google/callback`
9. Copy **Client ID** and **Client Secret** to your `.env` file

### OAuth callback behavior (frontend + backend)

This service uses a **backend-for-frontend** pattern for web auth:

- The backend handles the OAuth exchange at `GET /auth/google/callback`.
- It stores the authenticated user in a **server-side session** (cookie-based).
- It then **redirects the browser to your frontend** (configured via `FRONTEND_REDIRECT_URL`).
- After redirect, your frontend should call backend APIs (e.g. `GET /me`) and the browser will automatically send the session cookie.

## 🔗 API Endpoints

### Public Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| POST | `/auth/signup` | Signup with email + password (creates session) |
| GET | `/auth/trainer/google` | Start trainer login/signup with Google (sets role=trainer then redirects to `/auth/google`) |
| GET | `/auth/google` | Start Google OAuth (redirects to Google) |
| GET | `/auth/google/callback` | OAuth callback (creates/updates user + ensures trainer profile) |

### Protected Endpoints (Requires Authentication)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/me` | Get current user info |
| GET | `/auth/logout` | Logout |
| GET | `/me` | Get current trainer profile (flattened) |
| PATCH | `/trainer` | Update trainer + address + socials (onboarding) |
| GET | `/dashboard` | User dashboard |
| GET | `/users` | List all users |
| POST | `/users` | Create user (manual) |

> Note: There is a mobile (JWT/Bearer token) login endpoint and JWT plugin wiring in the codebase, but it is currently commented out in `api/routes/auth.js` and `api/index.js`. The Postman collection includes the request for convenience if/when it’s re-enabled.

## 🧪 Testing the API

### Login with Google

1. Visit: http://localhost:3000/auth/google
2. Login with your Google account
3. You'll be redirected to `/dashboard`

### Check Authentication

```bash
# After logging in via browser, check your session
curl http://localhost:3000/auth/me
```

### Access Protected Route

```bash
# Will only work if authenticated
curl http://localhost:3000/dashboard
```

### View Database

```bash
npm run db:studio
```

Opens Prisma Studio at http://localhost:5555

## 📁 Project Structure

```
treinoway-service/
├── api/
│   ├── index.js              # Main server file
│   ├── routes/
│   │   └── auth.js           # Authentication routes
│   └── middleware/
│       └── auth.js           # Auth middleware
├── src/
│   ├── db.js                 # Prisma client instance
│   └── helpers/
│       └── auth.js           # OAuth helper functions
├── prisma/
│   ├── schema.prisma         # Database schema
│   └── migrations/           # Database migrations
├── docs/
│   └── adding-new-sso-provider-example.js  # How to add new SSO
├── docker-compose.yml        # PostgreSQL container config
├── prisma.config.js          # Prisma CLI config
├── .env                      # Environment variables (not in git)
└── package.json              # Dependencies & scripts
```

## 🐳 Docker Configuration

PostgreSQL runs in Docker on port **5433** (not 5432 to avoid conflicts).

Data persists in Docker volume `postgres_data`.

## 🚨 Troubleshooting

### Port 5433 already in use

Change the port in `docker-compose.yml` and update `DATABASE_URL` in `.env`:

```yaml
ports:
  - "5434:5432"  # Use different port
```

### Database connection fails

1. Ensure Docker is running
2. Check database is up: `docker ps`
3. Restart database: `npm run db:reset`

### Prisma Client not found

Regenerate the client:

```bash
npm run db:generate
```

## 📝 Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `HOST` | Server host | `0.0.0.0` |
| `DATABASE_URL` | PostgreSQL connection | `postgresql://user:pass@localhost:5433/db` |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client ID | `123-abc.apps.googleusercontent.com` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth secret | `GOCSPX-xxx` |
| `GOOGLE_OAUTH_CALLBACK_URL` | OAuth redirect URI | `http://localhost:3000/auth/google/callback` |
| `SESSION_SECRET` | Session encryption key | Random string (min 32 chars) |
