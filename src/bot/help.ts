// src/bot/help.ts
// Shared by /start and the access-approval message.
import { config } from "../config"

export const HELP_TEXT =
  "Welcome to TeleCal! 🍽️\n\n" +
  "Track your calories and protein with AI-powered estimation.\n\n" +
  "Commands:\n" +
  "/log - Log what you ate, e.g. /log 2 eggs and toast\n" +
  "/today - See today's calories and protein\n" +
  "/week - See past 7 days\n" +
  "/month - See past 30 days\n" +
  "/edit - Edit a food entry\n" +
  "/delete - Delete a food entry\n" +
  "/pending - View pending estimations\n" +
  "/usage - See your AI token usage\n" +
  "/settings - Change preferences\n" +
  "/emoji - Pick your badge in a group, e.g. /emoji 🦊\n\n" +
  'Tip: Type "cancel" to abort any active conversation.\n\n' +
  `Privacy: what TeleCal stores and shares → ${config.web.baseUrl}/#privacy`
