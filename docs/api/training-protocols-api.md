# Training Protocols API Documentation

> **Frontend Team Guide** - Complete API reference for implementing the Training Protocol feature

Last updated: 2026-02-14

---

## Table of Contents

- [Overview](#overview)
- [Authentication & Authorization](#authentication--authorization)
- [Data Models](#data-models)
- [API Endpoints](#api-endpoints)
  - [Protocol Templates](#protocol-templates)
  - [Training Protocols (Trainer)](#training-protocols-trainer)
  - [Training Protocols (Student)](#training-protocols-student)
  - [Training Templates](#training-templates)
  - [Trainings](#trainings)
- [Common Patterns](#common-patterns)
- [Workflow Examples](#workflow-examples)
- [Error Handling](#error-handling)

---

## Overview

The Training Protocol system allows trainers to create and manage workout protocols for students. It supports:

- ✅ Reusable protocol and training templates
- ✅ Weekly scheduling with multiple trainings per day
- ✅ Public and private training templates
- ✅ Protocol lifecycle management (active, completed, archived)
- ✅ Dual-role users (trainer who is also a student)

### Key Concepts

- **Protocol Template**: Reusable protocol structure created by trainers
- **Training Protocol**: Actual protocol assigned to a student with dates
- **Training Template**: Reusable exercise/workout template
- **Training**: Specific workout within a protocol
- **Training Schedule**: Maps trainings to weekdays with ordering

---

## Authentication & Authorization

### Authorization Model

**IMPORTANT**: The backend uses `User.roles` array for ALL authorization decisions. The `activeProfile` field is a **UI preference only** and is **NOT checked by the backend**.

```typescript
// User roles (backend authorization)
roles: ['trainer'] // New users start with []; can add trainer via /become-trainer

// Active profile (frontend UI state only)
activeProfile: 'trainer' | 'student'
```

### How It Works

```javascript
// Backend checks User.roles (stored in JWT/session)
// Frontend uses activeProfile to decide which endpoints to call

// Example: Trainer who is also an assignee of another protocol
const user = {
  roles: ['trainer'],             // Backend: TRAINER role for trainer endpoints
  activeProfile: 'trainer'        // Frontend: show trainer UI, call /trainer/* endpoints
};

// If user switches to assignee view:
user.activeProfile = 'student';  // Frontend now calls /my/* endpoints
// Backend still allows both - it doesn't check activeProfile!
```

### API Design Pattern

Endpoints are separated by context:

- **`/trainer/*`** - Trainer operations (require TRAINER role)
- **`/my/*`** - Protocol assignee operations (require authentication only; protocols assigned to this user)

Frontend chooses which endpoint to call based on `activeProfile`:

```javascript
const endpoint = activeProfile === 'trainer'
  ? '/trainer/protocols'  // Protocols I created
  : '/my/protocols';      // Protocols assigned to me
```

### Becoming a Trainer

To access trainer endpoints (e.g. `/trainer/protocols`), the user must have the TRAINER role. Call:

```
PATCH /become-trainer
Authorization: Bearer <accessToken>
```

**Response (200):**
```json
{
  "activeProfile": "trainer",
  "token": { "accessToken": "<new-jwt-with-trainer-role>" },
  "refreshToken": "<new-refresh-token>"
}
```

**Important:** Use the new `token.accessToken` for subsequent trainer API calls. The old token does not include the TRAINER role.

### Including Bearer Token

All requests require authentication:

```javascript
const response = await fetch('https://api.treinoway.com/trainer/protocols', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }
});
```

---

## Data Models

### TypeScript Interfaces

```typescript
// Protocol Template
interface TrainingProtocolTemplate {
  id: string; // UUID
  trainerId: string; // UUID
  name: string;
  description: string | null;
  availableWeekDays: WeekDay[];
  defaultDurationWeeks: number | null;
  createdAt: string; // ISO 8601
  updatedAt: string | null;
  deletedAt: string | null;
}

// Training Protocol
interface TrainingProtocol {
  id: string;
  assigneeId: string;  // User ID of the assignee
  trainerId: string;
  protocolTemplateId: string | null;
  name: string;
  description: string | null;
  availableWeekDays: WeekDay[];
  status: 'active' | 'completed' | 'archived';
  startDate: string; // YYYY-MM-DD
  expirationDate: string | null; // YYYY-MM-DD
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;

  // Relations (when included)
  assignee?: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  };
  trainer?: {
    user: {
      id: string;
      firstName: string;
      lastName: string;
      avatarUrl: string | null;
    };
  };
  trainings?: Training[];
}

// Training Template
interface TrainingTemplate {
  id: string;
  trainerId: string;
  name: string;
  description: string | null;
  category: TrainingCategory;
  bodySegment: BodySegment | null;
  tags: string[];
  isPublic: boolean;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
}

// Training
interface Training {
  id: string;
  trainingProtocolId: string;
  trainingTemplateId: string | null;
  name: string;
  description: string | null;
  category: TrainingCategory;
  bodySegment: BodySegment | null;
  order: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;

  // Relations
  schedules?: TrainingSchedule[];
}

// Training Schedule
interface TrainingSchedule {
  id: string;
  trainingProtocolId: string;
  trainingId: string;
  weekDay: WeekDay;
  order: number;
  createdAt: string;
  updatedAt: string | null;
}

// Enums
type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

type TrainingCategory = 'strength' | 'cardio' | 'flexibility' | 'rest' | 'functional' | 'mobility';

type BodySegment = 'upper' | 'lower' | 'core' | 'full_body';

type ProtocolStatus = 'active' | 'completed' | 'archived';
```

---

## API Endpoints

### Protocol Templates

**Base URL**: `/trainer/protocol-templates`

**Role Required**: TRAINER

#### Create Protocol Template

```
POST /trainer/protocol-templates
```

**Request Body:**
```json
{
  "name": "Hypertrophy 12-Week",
  "description": "12-week muscle building protocol",
  "availableWeekDays": ["monday", "wednesday", "friday"],
  "defaultDurationWeeks": 12
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "trainerId": "uuid",
  "name": "Hypertrophy 12-Week",
  "description": "12-week muscle building protocol",
  "availableWeekDays": ["monday", "wednesday", "friday"],
  "defaultDurationWeeks": 12,
  "createdAt": "2026-02-12T10:30:00Z",
  "updatedAt": null
}
```

#### List My Templates

```
GET /trainer/protocol-templates
```

**Response (200):** Array of `TrainingProtocolTemplate`

#### Get Template by ID

```
GET /trainer/protocol-templates/:id
```

**Response (200):** `TrainingProtocolTemplate`

#### Update Template

```
PATCH /trainer/protocol-templates/:id
```

**Request Body:** (all fields optional)
```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "availableWeekDays": ["monday", "tuesday", "thursday"],
  "defaultDurationWeeks": 16
}
```

**Response (200):** Updated `TrainingProtocolTemplate`

#### Delete Template

```
DELETE /trainer/protocol-templates/:id
```

**Response (200):** Deleted template with `deletedAt` timestamp

---

### Training Protocols (Trainer)

**Base URL**: `/trainer/protocols`

**Role Required**: TRAINER

#### Create Protocol

```
POST /trainer/protocols
```

**Request Body:**
```json
{
  "assigneeId": "uuid",
  "name": "John's Custom Program",
  "description": "Personalized strength program",
  "availableWeekDays": ["monday", "wednesday", "friday"],
  "status": "active",
  "startDate": "2026-02-15",
  "expirationDate": "2026-05-15"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "assigneeId": "uuid",
  "trainerId": "uuid",
  "name": "John's Custom Program",
  "description": "Personalized strength program",
  "availableWeekDays": ["monday", "wednesday", "friday"],
  "status": "active",
  "startDate": "2026-02-15",
  "expirationDate": "2026-05-15",
  "createdAt": "2026-02-12T10:30:00Z",
  "assignee": {
    "id": "uuid",
    "firstName": "John",
    "lastName": "Doe",
    "avatarUrl": "https://..."
  }
}
```

#### List My Protocols

```
GET /trainer/protocols?status=active&assigneeId=uuid
```

**Query Parameters:**
- `status` (optional): Filter by status ('active', 'completed', 'archived')
- `assigneeId` (optional): Filter by assignee user ID

**Response (200):** Array of `TrainingProtocol` with assignee info

#### Get Protocol by ID

```
GET /trainer/protocols/:id
```

**Response (200):** Full `TrainingProtocol` with trainings and schedules

#### Update Protocol

```
PATCH /trainer/protocols/:id
```

**Request Body:** (all fields optional)
```json
{
  "name": "Updated Name",
  "status": "completed",
  "expirationDate": "2026-06-15"
}
```

**Response (200):** Updated `TrainingProtocol`

#### Delete Protocol

```
DELETE /trainer/protocols/:id
```

**Response (200):** Deleted protocol

#### Import from Template

```
POST /trainer/protocols/from-template
```

**Request Body:**
```json
{
  "templateId": "uuid",
  "assigneeId": "uuid",
  "name": "John's Hypertrophy Program",
  "startDate": "2026-02-15",
  "expirationDate": "2026-05-15"
}
```

**Response (201):** Created `TrainingProtocol` (independent copy from template)

---

### Training Protocols (My)

**Base URL**: `/my/protocols`

**Role Required**: Authentication only (no specific role; protocols assigned to authenticated user)

#### List My Protocols

```
GET /my/protocols?status=active
```

**Query Parameters:**
- `status` (optional): Filter by status ('active', 'completed', 'archived')

**Response (200):** Array of protocols assigned to the authenticated user with trainer info and trainings

```json
[
  {
    "id": "uuid",
    "assigneeId": "uuid",
    "trainerId": "uuid",
    "name": "Full Body Protocol",
    "status": "active",
    "startDate": "2023-12-31",
    "expirationDate": "2024-02-29",
    "trainer": {
      "id": "uuid",
      "firstName": "John",
      "lastName": "Trainer",
      "avatarUrl": "https://..."
    },
    "trainings": []
  }
]
```

#### Get Protocol by ID

```
GET /my/protocols/:id
```

**Response (200):** Full protocol details with trainings (excludes `assignee` since it's the authenticated user)

```json
{
  "id": "uuid",
  "assigneeId": "uuid",
  "trainerId": "uuid",
  "name": "Full Body Protocol",
  "description": "A comprehensive full body training protocol",
  "availableWeekDays": ["monday", "wednesday", "friday"],
  "status": "active",
  "startDate": "2023-12-31",
  "expirationDate": "2024-02-29",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "trainer": {
    "id": "uuid",
    "firstName": "John",
    "lastName": "Trainer",
    "avatarUrl": "https://..."
  },
  "trainings": []
}
```

---

### Training Templates

**Base URL**: `/trainer/training-templates`

**Role Required**: TRAINER

#### Create Training Template

```
POST /trainer/training-templates
```

**Request Body:**
```json
{
  "name": "Chest Day - Hypertrophy",
  "description": "Focus on chest muscle development",
  "category": "strength",
  "bodySegment": "upper",
  "tags": ["chest", "hypertrophy", "intermediate"],
  "isPublic": false
}
```

**Response (201):** Created `TrainingTemplate`

#### List My Templates

```
GET /trainer/training-templates
```

Returns own templates + public templates from other trainers

**Response (200):** Array of `TrainingTemplate`

#### Get Public Templates

```
GET /trainer/training-templates/public
```

**Response (200):** Array of public `TrainingTemplate`

#### Get Template by ID

```
GET /trainer/training-templates/:id
```

**Response (200):** `TrainingTemplate`

#### Update Template

```
PATCH /trainer/training-templates/:id
```

**Request Body:** (all fields optional)
```json
{
  "name": "Updated Name",
  "isPublic": true
}
```

**Response (200):** Updated template

#### Delete Template

```
DELETE /trainer/training-templates/:id
```

**Response (200):** Deleted template

---

### Trainings

**Role Required**: TRAINER (create/update/delete), STUDENT (read-only)

#### Create Training (Trainer)

```
POST /trainer/protocols/:protocolId/trainings
```

**Request Body:**
```json
{
  "name": "Upper Body Strength",
  "description": "Compound movements focusing on strength",
  "category": "strength",
  "bodySegment": "upper",
  "order": 1,
  "notes": "Focus on form over weight"
}
```

**Response (201):** Created `Training`

#### List Trainings

Trainer:
```
GET /trainer/protocols/:protocolId/trainings
```

Assignee:
```
GET /my/protocols/:protocolId/trainings
```

**Response (200):** Array of `Training` with schedules

#### Get Training by ID

Trainer:
```
GET /trainer/trainings/:id
```

Assignee:
```
GET /my/trainings/:id
```

**Response (200):** `Training` with full details

#### Update Training (Trainer)

```
PATCH /trainer/trainings/:id
```

**Request Body:** (all fields optional)
```json
{
  "name": "Updated Name",
  "notes": "Updated notes"
}
```

**Response (200):** Updated training

#### Delete Training (Trainer)

```
DELETE /trainer/trainings/:id
```

**Response (200):** Deleted training

#### Import from Template (Trainer)

```
POST /trainer/trainings/from-template
```

**Request Body:**
```json
{
  "protocolId": "uuid",
  "templateId": "uuid",
  "name": "Custom Name",
  "order": 1
}
```

**Response (201):** Created training (independent copy from template)

#### Schedule Training (Trainer)

```
POST /trainer/trainings/:id/schedule
```

**Request Body:**
```json
{
  "weekDays": ["monday", "wednesday", "friday"],
  "order": 1
}
```

**Response (201):** Array of created `TrainingSchedule`

---

## Common Patterns

### Date Format

All dates use **ISO 8601** format:

- **Date only**: `YYYY-MM-DD` (e.g., `"2026-02-15"`)
- **DateTime**: `YYYY-MM-DDTHH:mm:ssZ` (e.g., `"2026-02-12T10:30:00Z"`)

### UUID Format

All IDs are UUIDs: `"550e8400-e29b-41d4-a716-446655440000"`

### Pagination

Currently not implemented. All list endpoints return full arrays.

### Filtering and Sorting

Limited filtering via query parameters (see individual endpoints).

Default sorting:
- Protocols: `createdAt DESC`
- Trainings: `order ASC`

---

## Workflow Examples

### Example 1: Trainer Creates Protocol for Student

```javascript
// 1. Create protocol
const protocol = await fetch('/trainer/protocols', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    assigneeId: 'user-uuid',
    name: 'John\'s Program',
    startDate: '2026-02-15',
    availableWeekDays: ['monday', 'wednesday', 'friday']
  })
});

const { id: protocolId } = await protocol.json();

// 2. Add trainings to protocol
const training1 = await fetch(`/trainer/protocols/${protocolId}/trainings`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Upper Body',
    category: 'strength',
    bodySegment: 'upper',
    order: 1
  })
});

const { id: trainingId } = await training1.json();

// 3. Schedule training on specific days
await fetch(`/trainer/trainings/${trainingId}/schedule`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    weekDays: ['monday', 'friday'],
    order: 1
  })
});
```

### Example 2: Student Views Assigned Protocols

```javascript
// User switches to assignee view (protocols assigned to me)
user.activeProfile = 'student';

// Fetch protocols assigned to me (any authenticated user)
const response = await fetch('/my/protocols', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const protocols = await response.json();

// Display protocols to assignee
protocols.forEach(protocol => {
  console.log(`Protocol: ${protocol.name}`);
  console.log(`Trainer: ${protocol.trainer.user.firstName}`);
  console.log(`Trainings: ${protocol.trainings.length}`);
});
```

### Example 3: Dual-Role User Workflow

```javascript
const user = {
  roles: ['trainer'],
  activeProfile: 'trainer'
};

// View 1: As Trainer (protocols I created)
if (user.activeProfile === 'trainer') {
  const myProtocols = await fetch('/trainer/protocols');
  // Shows protocols I created for my assignees
}

// User switches view
user.activeProfile = 'student';

// View 2: As Assignee (protocols assigned to me)
if (user.activeProfile === 'student') {
  const assignedProtocols = await fetch('/my/protocols');
  // Shows protocols my trainer created for me
}

// Backend doesn't care about activeProfile!
// /trainer/* requires roles.includes('trainer'); /my/* requires auth only
```

### Example 4: Using Templates

```javascript
// 1. Create a training template (reusable)
const template = await fetch('/trainer/training-templates', {
  method: 'POST',
  body: JSON.stringify({
    name: 'Chest Day - Hypertrophy',
    category: 'strength',
    bodySegment: 'upper',
    isPublic: true // Make available to other trainers
  })
});

const { id: templateId } = await template.json();

// 2. Later: Import template into a protocol
const training = await fetch('/trainer/trainings/from-template', {
  method: 'POST',
  body: JSON.stringify({
    protocolId: 'protocol-uuid',
    templateId: templateId,
    name: 'Customized Chest Day', // Override template name
    order: 1
  })
});

// Training is now an independent copy - edits won't affect template
```

---

## Error Handling

### Standard Error Response

```typescript
interface ErrorResponse {
  error: string; // Error message
  message?: string; // Additional details
}
```

### Common HTTP Status Codes

| Code | Meaning | When |
|------|---------|------|
| 200 | OK | Successful GET, PATCH, DELETE |
| 201 | Created | Successful POST |
| 400 | Bad Request | Invalid data (validation failed) |
| 401 | Unauthorized | Missing or invalid auth token |
| 403 | Forbidden | User lacks required role or doesn't own resource |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Resource conflict (e.g., missing profile) |
| 500 | Server Error | Unexpected server error |

### Error Handling Example

```javascript
try {
  const response = await fetch('/trainer/protocols', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(protocolData)
  });

  if (!response.ok) {
    const error = await response.json();

    switch (response.status) {
      case 400:
        console.error('Validation error:', error.error);
        // Show user-friendly message
        break;
      case 401:
        console.error('Authentication failed');
        // Redirect to login
        break;
      case 403:
        console.error('Permission denied:', error.error);
        // Show "you don't have permission" message
        break;
      case 404:
        console.error('Resource not found:', error.error);
        // Show "not found" message
        break;
      default:
        console.error('Server error:', error.error);
        // Show generic error message
    }

    return;
  }

  const protocol = await response.json();
  console.log('Protocol created:', protocol);

} catch (err) {
  console.error('Network error:', err);
  // Show "connection failed" message
}
```

### Common Error Codes

| Code | Message | Solution |
|------|---------|----------|
| `TRAINER_PROFILE_MISSING` | Trainer profile not found | Ensure user has completed trainer onboarding |
| `ASSIGNEE_NOT_FOUND` | Assignee user not found | Ensure assigneeId is a valid user ID |
| `PROTOCOL_NOT_FOUND` | Protocol not found | Check protocol ID is valid |
| `TEMPLATE_NOT_FOUND` | Template not found | Check template ID is valid |
| `FORBIDDEN_NOT_PROTOCOL_OWNER` | You do not own this protocol | User can only modify their own protocols |
| `FORBIDDEN_NOT_YOUR_PROTOCOL` | This protocol is not assigned to you | Student can only view protocols assigned to them |
| `INVALID_WEEK_DAYS` | Invalid week days | Use valid values: 'monday', 'tuesday', etc. |
| `INVALID_STATUS` | Invalid status | Use 'active', 'completed', or 'archived' |
| `INVALID_CATEGORY` | Invalid category | Use 'strength', 'cardio', 'flexibility', etc. |

---

## Testing Notes

### Test Scenarios

1. **Trainer user**: User with TRAINER role (via /become-trainer)
2. **Assignee user**: Any authenticated user can view protocols assigned to them via /my/protocols
3. **Ownership validation**: Ensure users can only modify their own resources
4. **Template independence**: Verify edits to imported trainings don't affect templates
5. **Multiple trainings per day**: Test scheduling same training on multiple days
6. **Protocol lifecycle**: Test transitions between active → completed → archived

### Sample Test Data

```javascript
// Create test trainer (via signup + PATCH /become-trainer)
const trainer = {
  userId: 'trainer-uuid',
  roles: ['trainer'],
  activeProfile: 'trainer'
};

// Create test assignee (user who receives protocols; any authenticated user)
const assignee = {
  userId: 'assignee-uuid',
  roles: []  // No role required for /my/protocols
};
```

---

## Support

For questions or issues:
- Backend API: Check Swagger docs at `/docs`
- Postman Collection: `postman/Treinoway.postman_collection.json`
- Report issues: GitHub repository

---

**Version**: 1.0.0
**Last Updated**: 2026-02-14
**Maintained by**: Backend Team
