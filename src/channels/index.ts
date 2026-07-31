// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack
import './slack.js';

// telegram

// whatsapp — disabled 2026-07-31: unused channel, was stuck in a reconnect
// loop (440k retries / 99MB log). Re-enable by restoring the import.
// import './whatsapp.js';
