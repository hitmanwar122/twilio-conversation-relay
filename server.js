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
const SYSTEM_PROMPT = `You are a helpful virtual assistant for a customer service center.
Your role is to:
1. Greet customers warmly
2. Understand their issue or question
3. Provide helpful information
4. If you cannot resolve the issue or the customer requests a human agent, escalate the call

Keep responses concise (1-2 sentences) since this is a voice conversation.
Be friendly, professional, and empathetic.

When you need to escalate to a human agent, respond with exactly: "ESCALATE: [reason]"
For example: "ESCALATE: Customer requested human agent" or "ESCALATE: Complex billing issue"`;

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
