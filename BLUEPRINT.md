# Implementation Blueprint

This document details how the Twilio ConversationRelay Voice Bot was built, step by step.

## Phase 1: Project Setup

### 1.1 Initialize Node.js Project

```bash
mkdir twilio-conversation-relay
cd twilio-conversation-relay
npm init -y
```

### 1.2 Install Dependencies

```bash
npm install express twilio openai ws dotenv jsforce
npm install --save-dev nodemon
```

**Dependencies explained:**
- `express` - HTTP server for webhooks
- `twilio` - Twilio API interactions (TaskRouter, task lookup)
- `openai` - OpenAI GPT API client
- `ws` - WebSocket server for ConversationRelay
- `dotenv` - Environment variable management
- `jsforce` - Salesforce integration (future use)
- `nodemon` - Development auto-reload

### 1.3 Configure Environment

Create `.env` file:

```env
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890
OPENAI_API_KEY=sk-your-key
FLEX_WORKSPACE_SID=WS_your_workspace_sid
FLEX_WORKFLOW_SID=WW_your_workflow_sid
PORT=3000
```

### 1.4 Create .gitignore

```
node_modules/
.env
*.log
.DS_Store
```

## Phase 2: Core Server Implementation

### 2.1 Server Initialization

```javascript
// server.js
require('dotenv').config();

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Initialize clients
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory conversation storage
const conversations = new Map();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
```

### 2.2 Define System Prompt

Create a comprehensive knowledge base for the AI:

```javascript
const SYSTEM_PROMPT = `You are a helpful virtual assistant for OWL Bank Credit Card Services.

## Available Products
- OWL Classic Card: No annual fee, 1% cashback
- OWL Rewards Plus: $95/year, 2-3% cashback
- OWL Business Elite: $125/year, business rewards
- OWL Platinum: $495/year, premium benefits

## Guidelines
- Keep responses concise (1-2 sentences) - this is a voice call
- Be friendly and professional
- For account-specific questions (balance, transactions, etc.), respond with:
  ESCALATE: [reason]

## Example Escalation
Customer: "What's my current balance?"
You: ESCALATE: Customer needs account balance information
`;
```

### 2.3 Incoming Call Handler

```javascript
// Handle incoming calls - return TwiML with ConversationRelay
app.post('/voice/incoming', (req, res) => {
  const { CallSid, From } = req.body;

  // Create conversation record
  conversations.set(CallSid, {
    callSid: CallSid,
    callerPhone: From,
    startTime: new Date().toISOString(),
    transcript: [],
    escalationReason: null
  });

  console.log(`Incoming call: ${CallSid} from ${From}`);

  // Build TwiML response
  const serverUrl = `wss://${req.headers.host}/conversation/${CallSid}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect action="/voice/handoff">
        <ConversationRelay
            url="${serverUrl}"
            voice="Google.en-US-Journey-F"
            welcomeGreeting="Hello! Thank you for calling OWL Bank Credit Card Services. How can I help you today?"
        />
    </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});
```

### 2.4 WebSocket Handler

```javascript
// Handle WebSocket connections from ConversationRelay
wss.on('connection', (ws, req) => {
  // Extract callSid from URL path
  const urlParts = req.url.split('/');
  const callSid = urlParts[urlParts.length - 1];

  console.log(`WebSocket connected for call: ${callSid}`);

  // Get conversation record
  const conversation = conversations.get(callSid);
  if (!conversation) {
    console.error(`No conversation found for ${callSid}`);
    ws.close();
    return;
  }

  // Initialize message history for OpenAI
  const messageHistory = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());

    switch (message.type) {
      case 'setup':
        console.log('ConversationRelay setup complete');
        break;

      case 'prompt':
        await handleCustomerSpeech(ws, message, conversation, messageHistory);
        break;

      case 'interrupt':
        console.log('Customer interrupted');
        break;

      case 'end':
        console.log('Call ended');
        break;
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket closed for call: ${callSid}`);
  });
});
```

### 2.5 AI Response Handler

```javascript
async function handleCustomerSpeech(ws, message, conversation, messageHistory) {
  const customerText = message.voicePrompt;
  console.log(`Customer: ${customerText}`);

  // Add to transcript
  conversation.transcript.push({
    role: 'customer',
    text: customerText,
    timestamp: new Date().toISOString()
  });

  // Add to OpenAI message history
  messageHistory.push({ role: 'user', content: customerText });

  try {
    // Get AI response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messageHistory,
      max_tokens: 150,
      temperature: 0.7
    });

    const aiResponse = completion.choices[0].message.content;
    console.log(`Agent: ${aiResponse}`);

    // Check for escalation
    if (aiResponse.startsWith('ESCALATE:')) {
      const reason = aiResponse.replace('ESCALATE:', '').trim();
      conversation.escalationReason = reason;

      // Send friendly message before transfer
      ws.send(JSON.stringify({
        type: 'text',
        token: "I'll connect you with a specialist who can help with that. Please hold."
      }));

      // End conversation and trigger handoff
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'end',
          handoffData: JSON.stringify({ reason })
        }));
      }, 2000);

    } else {
      // Normal response
      messageHistory.push({ role: 'assistant', content: aiResponse });

      conversation.transcript.push({
        role: 'agent',
        text: aiResponse,
        timestamp: new Date().toISOString()
      });

      // Send response to be spoken
      ws.send(JSON.stringify({
        type: 'text',
        token: aiResponse
      }));
    }

  } catch (error) {
    console.error('OpenAI error:', error);
    ws.send(JSON.stringify({
      type: 'text',
      token: "I'm sorry, I'm having trouble right now. Let me connect you with an agent."
    }));
  }
}
```

## Phase 3: Escalation to Human Agents

### 3.1 Handoff Endpoint

```javascript
// Handle escalation to human agent
app.post('/voice/handoff', async (req, res) => {
  const { CallSid, From } = req.body;
  const conversation = conversations.get(CallSid);

  console.log(`Escalating call ${CallSid} to human agent`);

  // Build task attributes for Flex
  const taskAttributes = {
    type: 'inbound',
    name: From,
    from: From,
    direction: 'inbound',
    callSid: CallSid,
    conversationSummary: conversation?.transcript
      .filter(t => t.role === 'customer')
      .map(t => t.text)
      .join(' ')
      .substring(0, 500),
    virtualAgentTranscript: JSON.stringify(conversation?.transcript || []),
    escalationReason: conversation?.escalationReason || 'Customer requested agent'
  };

  // Create TaskRouter task
  try {
    const task = await twilioClient.taskrouter.v1
      .workspaces(process.env.FLEX_WORKSPACE_SID)
      .tasks
      .create({
        workflowSid: process.env.FLEX_WORKFLOW_SID,
        attributes: JSON.stringify(taskAttributes)
      });

    console.log(`Created task: ${task.sid}`);

    // Return TwiML to enqueue call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Please hold while I connect you with a specialist.</Say>
    <Enqueue workflowSid="${process.env.FLEX_WORKFLOW_SID}">
        <Task>${JSON.stringify(taskAttributes)}</Task>
    </Enqueue>
</Response>`;

    res.type('text/xml').send(twiml);

  } catch (error) {
    console.error('TaskRouter error:', error);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>We're experiencing technical difficulties. Please try again later.</Say>
    <Hangup/>
</Response>`);
  }
});
```

## Phase 4: Transcript API for Salesforce

### 4.1 Transcript Retrieval Endpoint

```javascript
// Get transcript by CallSid or TaskSid
app.get('/api/transcript/:identifier', async (req, res) => {
  const { identifier } = req.params;

  // Determine if it's a CallSid or TaskSid
  if (identifier.startsWith('CA')) {
    // Direct CallSid lookup
    const conversation = conversations.get(identifier);
    if (conversation) {
      return res.json(conversation);
    }
    return res.status(404).json({ error: 'Conversation not found' });
  }

  if (identifier.startsWith('WT')) {
    // TaskSid - need to look up the associated CallSid
    try {
      const task = await twilioClient.taskrouter.v1
        .workspaces(process.env.FLEX_WORKSPACE_SID)
        .tasks(identifier)
        .fetch();

      const attributes = JSON.parse(task.attributes);
      const callSid = attributes.callSid;

      const conversation = conversations.get(callSid);
      if (conversation) {
        return res.json(conversation);
      }

      // Return transcript from task attributes if not in memory
      if (attributes.virtualAgentTranscript) {
        return res.json({
          callSid: callSid,
          transcript: JSON.parse(attributes.virtualAgentTranscript)
        });
      }

      return res.status(404).json({ error: 'Conversation not found' });

    } catch (error) {
      console.error('Task lookup error:', error);
      return res.status(500).json({ error: 'Failed to lookup task' });
    }
  }

  return res.status(400).json({ error: 'Invalid identifier format' });
});
```

### 4.2 Monitoring Endpoint

```javascript
// View active conversations
app.get('/monitor', (req, res) => {
  const active = [];
  conversations.forEach((conv, callSid) => {
    active.push({
      callSid,
      callerPhone: conv.callerPhone,
      startTime: conv.startTime,
      messageCount: conv.transcript.length,
      escalated: !!conv.escalationReason
    });
  });
  res.json(active);
});
```

## Phase 5: Start Server

```javascript
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/conversation/{callSid}`);
});
```

## Phase 6: Twilio Configuration

### 6.1 Phone Number Setup

1. Go to Twilio Console > Phone Numbers
2. Select your phone number
3. Under "Voice & Fax":
   - Set "A Call Comes In" to Webhook
   - URL: `https://your-domain/voice/incoming`
   - HTTP Method: POST

### 6.2 Get Flex/TaskRouter SIDs

1. Go to Twilio Console > TaskRouter > Workspaces
2. Copy the Workspace SID (starts with WS)
3. Click on the workspace > Workflows
4. Copy the Workflow SID (starts with WW)

## Phase 7: Salesforce Integration

### 7.1 Lightning Web Component

Create an LWC to display the transcript in Salesforce:

```javascript
// conversationTranscript.js
import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';

export default class ConversationTranscript extends LightningElement {
    @api recordId;
    transcript = [];

    @wire(getRecord, { recordId: '$recordId', fields: ['VoiceCall.VendorCallKey'] })
    async handleRecord({ data, error }) {
        if (data) {
            const taskSid = getFieldValue(data, 'VoiceCall.VendorCallKey');
            await this.fetchTranscript(taskSid);
        }
    }

    async fetchTranscript(taskSid) {
        try {
            const response = await fetch(`https://your-domain/api/transcript/${taskSid}`);
            const data = await response.json();
            this.transcript = data.transcript;
        } catch (error) {
            console.error('Failed to fetch transcript:', error);
        }
    }
}
```

## Development Workflow

### Local Development

```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Start ngrok tunnel
ngrok http 3000
```

### Testing Checklist

- [ ] Incoming call creates conversation record
- [ ] WebSocket connects successfully
- [ ] Customer speech transcribed correctly
- [ ] AI responses are relevant and concise
- [ ] Escalation triggers correctly
- [ ] Task created in TaskRouter
- [ ] Transcript accessible via API
- [ ] Agent receives call with context

## Implementation Timeline

| Phase | Description | Key Files |
|-------|-------------|-----------|
| 1 | Project setup | package.json, .env |
| 2 | Core server | server.js (HTTP + WebSocket) |
| 3 | Escalation | TaskRouter integration |
| 4 | API | Transcript endpoints |
| 5 | Deploy | Server startup |
| 6 | Twilio | Console configuration |
| 7 | Salesforce | LWC component |

## Key Design Decisions

### 1. WebSocket vs REST

**Decision:** Use WebSocket for ConversationRelay communication

**Rationale:**
- Real-time bidirectional communication required
- Lower latency for voice interactions
- ConversationRelay requires WebSocket

### 2. In-Memory Storage

**Decision:** Use JavaScript Map for conversation storage

**Rationale:**
- Simple implementation for MVP
- Fast access during active calls
- Trade-off: Data lost on restart

**Future:** Migrate to Redis for persistence and scaling

### 3. Single System Prompt

**Decision:** One comprehensive system prompt vs dynamic prompts

**Rationale:**
- Consistent behavior across calls
- Easier to maintain and update
- Contains full knowledge base

### 4. Escalation Detection

**Decision:** Use `ESCALATE:` prefix in AI responses

**Rationale:**
- Simple, reliable detection
- Allows AI to decide when escalation needed
- Reason passed to human agent

### 5. TaskSid Lookup

**Decision:** Support both CallSid and TaskSid in transcript API

**Rationale:**
- Salesforce VoiceCall stores TaskSid, not CallSid
- Maintains flexibility for different integrations
- Single endpoint serves multiple use cases

## Error Handling Strategy

| Scenario | Handling |
|----------|----------|
| OpenAI API failure | Send apology message, trigger escalation |
| WebSocket disconnect | Log error, cleanup conversation |
| TaskRouter failure | Return error TwiML with apology |
| Invalid transcript request | Return appropriate HTTP status |

## Monitoring & Debugging

### Console Logging

```
Incoming call: CA1234... from +1555...
WebSocket connected for call: CA1234...
Customer: What's my balance?
Agent: ESCALATE: Customer needs account balance information
Escalating call CA1234... to human agent
Created task: WT5678...
```

### Monitor Endpoint

`GET /monitor` returns:
```json
[
  {
    "callSid": "CA1234...",
    "callerPhone": "+15551234567",
    "startTime": "2026-01-29T10:30:00.000Z",
    "messageCount": 4,
    "escalated": true
  }
]
```
