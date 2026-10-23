// Ready-made broadcast messages for the Admin → Broadcast page: follow and share our pages, ask for feedback, ideas and a store rating.
// Each one fills the title and message and attaches its pictures (public/community/*.jpg, made for these messages). The admin can edit anything
// before sending. Messages are kept under the 800-character limit.

export const INSTAGRAM_URL = 'https://www.instagram.com/family.ledger/';
export const FACEBOOK_URL = 'https://www.facebook.com/profile.php?id=61594046441653';
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
export const FEEDBACK_URL = 'https://familyledger.thirteenapps.com/feedback'; // opens the Feedback screen inside the app

export interface BroadcastTemplate {
  id: string;
  label: string;
  emoji: string;
  hint: string; // one line shown under the chips
  title: string;
  message: string;
  images: string[]; // paths under /community
  imageLinks: string[]; // where tapping each picture goes, in the same order
}

export const BROADCAST_TEMPLATES: BroadcastTemplate[] = [
  {
    id: 'join',
    label: 'Join our community',
    emoji: '💚',
    hint: 'Asks people to follow Instagram and Facebook, share the pages and give feedback. Three pictures.',
    title: 'Join the FamilyLedger family 💚',
    message: `Hi! Thank you for being part of FamilyLedger. 🙏

We're building a community of families who manage money together, and we'd love you to be in it.

📸 Instagram: ${INSTAGRAM_URL}
👍 Facebook: ${FACEBOOK_URL}

You'll find money tips, new features first, and stories from other families.

Three small things that mean a lot:
• Follow us and share our pages with family and friends
• Share your weekly recap with someone who'd love it
• Tell us what you love or what to improve: ${FEEDBACK_URL}

Every share helps another family get organised. Thank you! 💙
Team FamilyLedger`,
    images: ['join-community.jpg', 'join-instagram.jpg', 'join-facebook.jpg'],
    imageLinks: [INSTAGRAM_URL, INSTAGRAM_URL, FACEBOOK_URL],
  },
  {
    id: 'instagram',
    label: 'Follow on Instagram',
    emoji: '📸',
    hint: 'Follow and share the Instagram page. One picture.',
    title: 'Follow us on Instagram 📸',
    message: `Daily money tips, family stories and sneak peeks of what's coming next are waiting on our Instagram page.

👉 ${INSTAGRAM_URL}

Tap Follow, and share a post with someone who'd love it. Tag us @family.ledger and we'll feature our favourites!

Thank you for helping our family grow. 💜
Team FamilyLedger`,
    images: ['join-instagram.jpg'],
    imageLinks: [INSTAGRAM_URL],
  },
  {
    id: 'facebook',
    label: 'Follow on Facebook',
    emoji: '👍',
    hint: 'Like, follow and share the Facebook page. One picture.',
    title: 'Like and follow us on Facebook 👍',
    message: `Our Facebook page is where we share updates, new features and tips, and where our community says hello.

👉 ${FACEBOOK_URL}

Please like and follow the page, and share a post with a friend or relative who could use a simpler way to manage family money.

Thank you for being part of the family. 💙
Team FamilyLedger`,
    images: ['join-facebook.jpg'],
    imageLinks: [FACEBOOK_URL],
  },
  {
    id: 'share',
    label: 'Share with friends',
    emoji: '💌',
    hint: 'Asks people to forward the pages and the app to someone who needs it. One picture.',
    title: 'Know someone who needs this? 💌',
    message: `FamilyLedger is better with family. Forward our pages to a friend, a flatmate or a relative who could use an easier way to share expenses:

📸 ${INSTAGRAM_URL}
👍 ${FACEBOOK_URL}

Or send them the app: ${PLAY_URL}

You can also share your weekly recap from inside the app: one tap to WhatsApp, Instagram or Facebook.

Every share helps another family get organised. Thank you! 💚
Team FamilyLedger`,
    images: ['join-community.jpg'],
    imageLinks: [PLAY_URL],
  },
  {
    id: 'feedback',
    label: 'Ask for feedback',
    emoji: '💬',
    hint: 'Invites feedback in under a minute, with a button to the Feedback screen. One picture.',
    title: "We'd love to hear from you 💬",
    message: `FamilyLedger is built around families like yours, so your opinion shapes it.

• What do you love?
• What is confusing or annoying?
• What should we add next?

Send us a note in under a minute:
${FEEDBACK_URL}

Every message is read by our team. Thank you for helping us get better! 🙏
Team FamilyLedger`,
    images: ['join-feedback.jpg'],
    imageLinks: [FEEDBACK_URL],
  },
  {
    id: 'ideas',
    label: 'Ask for ideas',
    emoji: '💡',
    hint: 'Asks what to build next. One picture.',
    title: 'What should we build next? 💡',
    message: `Your ideas make FamilyLedger better. Tell us:

💡 A feature you wish existed
🧩 Something that could work better
🎯 Your favourite part so far

Share it here: ${FEEDBACK_URL}

The most-asked ideas go on our list first, and we'll tell you when they ship. Thank you! 🚀
Team FamilyLedger`,
    images: ['join-feedback.jpg'],
    imageLinks: [FEEDBACK_URL],
  },
  {
    id: 'rate',
    label: 'Ask for a rating',
    emoji: '⭐',
    hint: 'Asks for a 5-star rating on Google Play, and for feedback first if something is wrong. One picture.',
    title: 'Enjoying FamilyLedger? Rate us ⭐',
    message: `A 5-star rating on Google Play helps other families find us.

⭐ ${PLAY_URL}

It takes about 10 seconds. If something isn't right, please tell us first and we'll fix it quickly: ${FEEDBACK_URL}

Thank you for being part of FamilyLedger! 💚
Team FamilyLedger`,
    images: ['join-rate.jpg'],
    imageLinks: [PLAY_URL],
  },
];
