# Twilio ConversationRelay Integration

AI-powered voice bot using Twilio ConversationRelay with Salesforce Service Cloud Voice integration.

## Features

- **Virtual Agent**: GPT-4o-mini powered voice bot handles initial customer interactions
- **Real-time Transcription**: Speech-to-text captures conversation
- **Escalation to Human**: Seamless handoff to Flex agents when needed
- **Salesforce Integration**: Transcript displayed in Service Console

## Architecture

```
Customer Call
     ↓
Twilio Phone Number
     ↓
ConversationRelay ←→ WebSocket Server ←→ OpenAI GPT
     ↓
[Transcript Stored]
     ↓
Escalate → Flex → Service Cloud Voice → Salesforce
                                            ↓
                                    LWC shows transcript
```

## Prerequisites

- Node.js 18+
- Twilio Account with Flex
- OpenAI API Key
- Salesforce org with Service Cloud Voice

## Setup

### 1. Install Dependencies

```bash
cd twilio-conversation-relay
npm install
```

### 2. Configure Environment

Edit `.env` with your credentials:

```env
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890
OPENAI_API_KEY=sk-your-key
PORT=3000
```

### 3. Start Server

```bash
npm start
```

### 4. Expose Server (for testing)

Use ngrok to expose your local server:

```bash
ngrok http 3000
```

### 5. Configure Twilio Phone Number

Set the Voice webhook URL to:
```
https://your-ngrok-url.ngrok.io/voice/incoming
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/voice/incoming` | POST | TwiML for incoming calls |
| `/voice/handoff` | POST | Handles escalation to agent |
| `/monitor` | GET | View active conversations |
| `/api/transcript/:callSid` | GET | Get transcript for a call |

## WebSocket Protocol

ConversationRelay connects via WebSocket to `/conversation/{callSid}`.

### Message Types

**Incoming:**
- `setup` - Connection established
- `prompt` - Customer speech transcription
- `interrupt` - Customer interrupted
- `end` - Call ended

**Outgoing:**
- `text` - Send text to speak
- `end` - End conversation (triggers handoff)

## Customization

### System Prompt

Edit `SYSTEM_PROMPT` in `server.js` to customize the virtual agent behavior.

### Voice Settings

In the TwiML `/voice/incoming` endpoint, modify:
- `voice` - TTS voice (e.g., 'Google.en-US-Journey-F')
- `language` - Language code
- `welcomeGreeting` - Initial greeting

## Salesforce Components

The transcript LWC is in the `twilio-scv-customizations` project:
- `conversationTranscript` - Displays transcript on VoiceCall record

## Deployment

For production, deploy to:
- Heroku
- Railway
- AWS Lambda + API Gateway
- Google Cloud Run

## License

MIT
