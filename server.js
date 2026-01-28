require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize clients
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Store active conversations (in production, use Redis or database)
const conversations = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// System prompt for the AI agent
const SYSTEM_PROMPT = `You are a virtual assistant for OWL Bank Credit Card Services.
Your tagline is "Wise Banking for a Brighter Future."

IMPORTANT RULES:
- Keep responses concise (1-2 sentences max) since this is a voice conversation
- Be friendly, professional, and empathetic
- Only answer questions about OWL Bank credit cards using the knowledge below
- If asked about account-specific details (balance, transactions, specific charges), escalate to human agent
- If customer requests a human agent, escalate immediately
- When you need to escalate, respond with exactly: "ESCALATE: [reason]"

=== OWL BANK CREDIT CARD KNOWLEDGE BASE ===

CARD TYPES:
1. OWL Classic Card - No annual fee, 1% cash back, requires 580+ credit score
2. OWL Rewards Plus - $95/year (waived first year), 2% cash back all purchases, 3% dining/gas, requires 670+ score
3. OWL Business Elite - $125/year, 3% office supplies/telecom, 2% advertising/gas, requires 690+ score
4. OWL Platinum - $495/year ($300 travel credit), 3% travel/dining, airport lounge access, requires 750+ score

APR RATES:
- OWL Classic: 16.99% - 24.99% variable
- OWL Rewards Plus: 14.99% - 21.99% variable
- OWL Business Elite: 13.99% - 20.99% variable
- OWL Platinum: 12.99% - 18.99% variable
- Balance transfers: 0% for 12-18 months (3% fee), then standard APR

FEES:
- Foreign transaction fees: 0% on ALL cards
- First authorized user: FREE
- Additional authorized users: $25/year each

HOW TO APPLY:
- Online at www.owlbank.com/apply (5-7 minutes, instant decision)
- Visit any of 2,400+ branch locations
- Call 1-800-OWL-CARD (1-800-695-2273)

CARD ACTIVATION:
- Online: www.owlbank.com/activate
- Phone: 1-800-OWL-ACTV (1-800-695-2288)
- Mobile app: Select 'Activate Card'

REWARDS REDEMPTION (10,000 points = $100):
- Statement credit
- Direct deposit to OWL checking
- Travel portal (25% bonus: 10,000 pts = $125)
- Gift cards to 200+ retailers
- Charitable donations
- Points never expire, minimum redemption 2,500 points ($25)

LOST/STOLEN CARD:
- Call immediately: 1-800-OWL-SAFE (1-800-695-7233)
- Or report via mobile app: Card Services > Report Lost/Stolen
- International: +1-302-555-0199
- Zero liability for unauthorized charges
- Free overnight replacement

AUTOPAY SETUP:
- Log in at owlbank.com or mobile app
- Go to Payment Options > AutoPay Enrollment
- Choose: minimum payment, statement balance, or custom amount
- Enroll by 15th for next statement

CREDIT LIMIT INCREASE:
- Automatic review every 6 months
- Can request after 90 days account open
- Online: Account Settings > Request Credit Limit Increase
- Or call 1-800-OWL-HELP
- Soft pull for good standing customers

BALANCE TRANSFER:
- 0% APR: 12 months (Rewards Plus), 15 months (Business Elite), 18 months (Platinum)
- 3% fee (minimum $5)
- Up to 75% of available credit
- Takes 7-10 business days

DISPUTE A CHARGE:
- Must notify within 60 days of statement
- Online: Select transaction > Dispute This Charge
- Phone: 1-800-OWL-HELP > Dispute a Transaction
- Temporary credit within 3 business days
- Investigation: 45 days (90 for international)

FRAUD PROTECTION:
- Zero liability protection
- Real-time AI fraud monitoring
- Instant transaction alerts (text/email/push)
- Virtual card numbers via app
- Lock/unlock card instantly in app
- Two-factor authentication

MOBILE APP FEATURES:
- View balance and available credit
- Make/schedule payments
- Activate or lock/unlock card
- Transaction history and spending analytics
- Generate virtual card numbers
- Check and redeem rewards
- Chat with customer service
- View 7 years of statements

AUTHORIZED USERS:
- Primary must be 18+, authorized users 13+ (16+ for business)
- Add via: Manage Authorized Users in account
- First user free, additional $25/year
- Helps build their credit (reported to bureaus)

CREDIT BUREAU REPORTING:
- Reports to Equifax, Experian, TransUnion monthly
- Reports: payment history, utilization, account age, credit limit
- Free FICO score in online account under Credit Score & Monitoring

CONTACT INFO:
- General: 1-800-OWL-HELP (1-800-695-4357) - 24/7
- Fraud: 1-800-OWL-SAFE (1-800-695-7233) - 24/7
- Applications: 1-800-OWL-CARD (1-800-695-2273)
- Activation: 1-800-OWL-ACTV (1-800-695-2288)
- Email: support@owlbank.com
- Website: www.owlbank.com
- 2,400+ branches nationwide

=== END KNOWLEDGE BASE ===

Remember: Be concise, helpful, and escalate for account-specific queries or when customer requests human agent.`;

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Twilio ConversationRelay Server' });
});

// Monitor endpoint to view conversations
app.get('/monitor', (req, res) => {
    const conversationList = [];
    conversations.forEach((conv, callSid) => {
        conversationList.push({
            callSid,
            callerPhone: conv.callerPhone,
            startTime: conv.startTime,
            transcript: conv.transcript
        });
    });
    res.json(conversationList);
});

// TwiML endpoint for incoming calls - connects to ConversationRelay
app.post('/voice/incoming', (req, res) => {
    const callSid = req.body.CallSid;
    const callerPhone = req.body.From;

    console.log(`Incoming call from ${callerPhone}, CallSid: ${callSid}`);

    // Initialize conversation tracking
    conversations.set(callSid, {
        callerPhone,
        startTime: new Date().toISOString(),
        transcript: [],
        callSid
    });

    const host = req.headers.host;
    const wsProtocol = host.includes('ngrok') ? 'wss' : 'ws';

    // Generate TwiML manually since SDK doesn't have conversationRelay method
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect action="https://${host}/voice/handoff">
        <ConversationRelay
            url="${wsProtocol}://${host}/conversation/${callSid}"
            voice="en-US-Neural2-F"
            welcomeGreeting="Hello! Thank you for calling. How can I help you today?"
        />
    </Connect>
</Response>`;

    console.log('TwiML Response:', twimlResponse);

    res.type('text/xml');
    res.send(twimlResponse);
});

// Handoff endpoint - called when escalating to agent
app.post('/voice/handoff', async (req, res) => {
    const callSid = req.body.CallSid;
    const conversation = conversations.get(callSid);

    console.log(`Escalating call ${callSid} to human agent`);
    console.log('Handoff request body:', req.body);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Please hold while I connect you with an agent.');

    // Task attributes for Flex/SCV
    const taskAttributes = {
        type: 'inbound',
        name: conversation?.callerPhone || req.body.From,
        from: conversation?.callerPhone || req.body.From,
        direction: 'inbound',
        callSid: callSid,
        conversationSummary: getConversationSummary(conversation),
        virtualAgentTranscript: JSON.stringify(conversation?.transcript || []),
        escalationReason: conversation?.escalationReason || 'Customer requested agent'
    };

    // Enqueue to Flex TaskRouter
    const enqueue = twiml.enqueue({
        workflowSid: process.env.FLEX_WORKFLOW_SID
    });
    enqueue.task({}, JSON.stringify(taskAttributes));

    console.log('Task attributes:', taskAttributes);

    res.type('text/xml');
    res.send(twiml.toString());
});

// API endpoint to get transcript for a call (supports both CallSid and TaskSid)
app.get('/api/transcript/:identifier', async (req, res) => {
    const identifier = req.params.identifier;

    // First, try direct lookup by CallSid
    let conversation = conversations.get(identifier);

    // If not found and identifier starts with WT (TaskSid), look up via Twilio API
    if (!conversation && identifier.startsWith('WT')) {
        try {
            console.log(`Looking up TaskSid ${identifier} via Twilio API`);
            const task = await twilioClient.taskrouter.v1
                .workspaces(process.env.FLEX_WORKSPACE_SID)
                .tasks(identifier)
                .fetch();

            const attributes = JSON.parse(task.attributes);
            const callSid = attributes.callSid || attributes.call_sid;

            if (callSid) {
                console.log(`Found callSid ${callSid} for task ${identifier}`);
                conversation = conversations.get(callSid);
            }
        } catch (error) {
            console.error(`Error looking up task ${identifier}:`, error.message);
        }
    }

    if (conversation) {
        res.json({
            success: true,
            callSid: conversation.callSid,
            transcript: conversation.transcript,
            callerPhone: conversation.callerPhone,
            startTime: conversation.startTime
        });
    } else {
        res.status(404).json({ success: false, error: 'Conversation not found' });
    }
});

// WebSocket handler for ConversationRelay
wss.on('connection', (ws, req) => {
    const pathParts = req.url.split('/');
    const callSid = pathParts[pathParts.length - 1];

    console.log(`WebSocket connected for call: ${callSid}`);

    let conversation = conversations.get(callSid) || {
        callerPhone: 'unknown',
        startTime: new Date().toISOString(),
        transcript: [],
        callSid
    };
    conversations.set(callSid, conversation);

    const messageHistory = [
        { role: 'system', content: SYSTEM_PROMPT }
    ];

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('Received:', message.type, message);

            switch (message.type) {
                case 'setup':
                    console.log('ConversationRelay setup complete');
                    break;

                case 'prompt':
                    // Customer spoke - process with OpenAI
                    const customerText = message.voicePrompt;
                    console.log(`Customer said: ${customerText}`);

                    // Add to transcript
                    conversation.transcript.push({
                        role: 'customer',
                        text: customerText,
                        timestamp: new Date().toISOString()
                    });

                    // Get AI response
                    messageHistory.push({ role: 'user', content: customerText });

                    const response = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: messageHistory,
                        max_tokens: 150,
                        temperature: 0.7
                    });

                    const assistantText = response.choices[0].message.content;
                    messageHistory.push({ role: 'assistant', content: assistantText });

                    // Add to transcript
                    conversation.transcript.push({
                        role: 'agent',
                        text: assistantText,
                        timestamp: new Date().toISOString()
                    });

                    console.log(`AI response: ${assistantText}`);

                    // Check for escalation
                    if (assistantText.includes('ESCALATE:')) {
                        const reason = assistantText.split('ESCALATE:')[1].trim();
                        console.log(`Escalating call: ${reason}`);

                        // Store escalation reason
                        conversation.escalationReason = reason;

                        // Tell customer we're transferring
                        ws.send(JSON.stringify({
                            type: 'text',
                            token: 'I understand. Let me connect you with a human agent who can better assist you.'
                        }));

                        // Small delay then end to trigger handoff
                        setTimeout(() => {
                            ws.send(JSON.stringify({
                                type: 'end',
                                handoffData: JSON.stringify({
                                    reason,
                                    transcript: conversation.transcript,
                                    summary: getConversationSummary(conversation)
                                })
                            }));
                        }, 2000);
                    } else {
                        // Send response back to ConversationRelay
                        ws.send(JSON.stringify({
                            type: 'text',
                            token: assistantText
                        }));
                    }
                    break;

                case 'interrupt':
                    console.log('Customer interrupted');
                    break;

                case 'error':
                    console.error('ConversationRelay error:', message);
                    break;

                case 'end':
                    console.log('Call ended');
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        console.log(`WebSocket closed for call: ${callSid}`);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for call ${callSid}:`, error);
    });
});

// Helper function to generate conversation summary
function getConversationSummary(conversation) {
    if (!conversation || !conversation.transcript.length) {
        return 'No conversation recorded';
    }

    const customerMessages = conversation.transcript
        .filter(t => t.role === 'customer')
        .map(t => t.text)
        .join(' ');

    return customerMessages.substring(0, 500);
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/conversation/{callSid}`);
    console.log(`Voice webhook: http://localhost:${PORT}/voice/incoming`);
});
