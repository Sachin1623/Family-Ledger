// Baby Vaccinations — deliberately NOT modeled on medicines.ts's daily-recurring-dose shape.
// A vaccination schedule is a finite, age-based SEQUENCE of one-time events (birth, 6 weeks,
// 10 weeks, 9 months, ...), often bundling several different vaccines into the same visit, tied
// to the child's date of birth rather than the calendar. See project memory for the fuller
// rationale (child profile vs. delegate model, visit-grouped entry, appointment-aware reminders).
//
// EVERY schedule below is illustrative/approximate — NOT medical advice, and not vetted against
// an official source. Treat ages/vaccine names as placeholders a real product would need a
// clinician to sign off on before shipping. This is why every screen that shows a generated
// schedule also carries a persistent, non-dismissible disclaimer pointing back to the child's own
// doctor and the actual local government schedule — see babyVax.scheduleDisclaimer.

export type VaccineDoseStatus = 'pending' | 'given' | 'skipped' | 'not_needed';
// One id per offered schedule, globally unique across countries (not just "govt vs private" within
// one country) — 'uip'/'iap' are India's government/private schedules, 'cdc' the US, 'nhs' the UK,
// 'who' a generic reference for any country without its own named template, 'blank' universal.
export type ScheduleTemplate = 'uip' | 'iap' | 'cdc' | 'nhs' | 'who' | 'blank';

export type Country = 'IN' | 'US' | 'UK' | 'other';
export const DEFAULT_COUNTRY: Country = 'IN';
export const COUNTRIES: { id: Country; label: string; flag: string }[] = [
  { id: 'IN', label: 'India', flag: '🇮🇳' },
  { id: 'US', label: 'United States', flag: '🇺🇸' },
  { id: 'UK', label: 'United Kingdom', flag: '🇬🇧' },
  { id: 'other', label: 'Other / not listed', flag: '🌍' },
];

// Which templates a country's picker offers — 'blank' (start empty, add doses by hand) is always
// available everywhere, since it needs no per-country data at all.
export const TEMPLATES_BY_COUNTRY: Record<Country, ScheduleTemplate[]> = {
  IN: ['uip', 'iap', 'blank'],
  US: ['cdc', 'blank'],
  UK: ['nhs', 'blank'],
  other: ['who', 'blank'],
};

export const TEMPLATE_META: Record<ScheduleTemplate, { titleKey: string; descKey: string }> = {
  uip: { titleKey: 'babyVax.templateUip', descKey: 'babyVax.templateUipDesc' },
  iap: { titleKey: 'babyVax.templateIap', descKey: 'babyVax.templateIapDesc' },
  cdc: { titleKey: 'babyVax.templateCdc', descKey: 'babyVax.templateCdcDesc' },
  nhs: { titleKey: 'babyVax.templateNhs', descKey: 'babyVax.templateNhsDesc' },
  who: { titleKey: 'babyVax.templateWho', descKey: 'babyVax.templateWhoDesc' },
  blank: { titleKey: 'babyVax.templateBlank', descKey: 'babyVax.templateBlankDesc' },
};

export interface BabyProfile {
  id: string;
  ownerUid: string; // whoever created the profile — the one uid with full/irrevocable control
  name: string;
  dob: string; // yyyy-mm-dd
  sex: 'male' | 'female' | 'other';
  photo: string | null;
  backgroundPhoto: string | null; // dashboard/profile banner image — decorative pattern shown when unset
  country: Country;
  scheduleTemplate: ScheduleTemplate;
  // Gestational age at birth, in completed weeks (e.g. 38) — optional; matters clinically because
  // a premature baby's vaccine schedule is sometimes adjusted, unlike a plain "days since dob"
  // calculation. Never used to compute due dates itself (dob still anchors the whole schedule) —
  // it's informational, for the parent/clinician's own judgement.
  birthWeek: number | null;
  motherBloodGroup: string | null;
  babyBloodGroup: string | null;
  reminderPrefs: ReminderPrefs;
  deletedAt: string | null; // soft-delete — moves the baby to the Deleted Babies list, restorable until permanently deleted
  createdAt: string;
  updatedAt: string;
}

// User-facing on/off switches over the three categories of reminder vaccinationReminders.ts can
// produce for a visit — every category still branches on that visit's own appointment state
// (booked / not booked / walk-in) exactly as before; these just gate whether each category fires
// AT ALL. Defaults all true (unchanged behavior for anyone who never opens Reminders settings).
export interface ReminderPrefs {
  leadUpNotices: boolean; // the 3/2/1-day-before notices, whichever date they're counting down to
  dayOfAlarm: boolean; // the due-date 9am alarm, or the 2h-before-appointment alarm
  overdueRecurring: boolean; // once overdue, an alarm every 3 days at 10am until resolved
}

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = { leadUpNotices: true, dayOfAlarm: true, overdueRecurring: true };

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

// One vaccine dose — the schedule slot AND its log entry are the same doc (unlike medicines,
// there's no separate recurring "prescription" vs. "instance" split: a dose either hasn't
// happened yet or it has, once, ever).
export interface VaccineDose {
  id: string;
  profileId: string;
  ownerUid: string; // copied from the profile at creation — lets rules key off it without a lookup
  visitKey: string; // stable milestone key, e.g. '6w' — groups doses into one visit
  visitLabel: string; // e.g. '6 Week Visit'
  dueDate: string; // yyyy-mm-dd, computed from dob + milestone offset (or set directly for a custom dose)
  vaccineName: string;
  doseNumber: number; // 0 for a birth-dose-style single administration
  status: VaccineDoseStatus;
  givenDate: string | null;
  // brand/batchNo/expiryDate/photoFront/photoBack are ONLY meaningful on a dose that ISN'T part of
  // a dose group (doseGroupId == null) — the doctor often gives one physical shot (one brand, one
  // batch, one proof photo) that covers several named vaccines at once (e.g. a combo/pentavalent
  // product), so a grouped dose keeps these null on itself and the shared values live once on the
  // vaccineDoseGroups doc doseGroupId points to instead. See VaccineDoseGroup below.
  brand: string | null;
  batchNo: string | null;
  expiryDate: string | null; // yyyy-mm-dd, printed on the vaccine vial/slip
  clinic: string | null;
  doctor: string | null;
  photoFront: string | null;
  photoBack: string | null;
  notes: string | null;
  doseGroupId: string | null;
  loggedBy: string;
  // Distinguishes a dose the chosen schedule template generated automatically from one a
  // caregiver added by hand (via "Add another vaccine") — shown as a badge everywhere a dose
  // appears, so it's always clear which parts of the schedule are the government/IAP standard and
  // which were a personal addition. Missing on any dose written before this field existed —
  // treated as 'template', a safe default since that's what the vast majority of pre-existing
  // doses actually are.
  source: 'template' | 'custom';
  // Soft-delete for a whole VISIT — set on every dose in a visitKey at once (see BabyVaccinations.tsx's
  // handleDeleteVisit). Excluded from Overdue/Upcoming/History and grouped into its own Deleted
  // section instead; restorable (clear it) or removable for real (an actual deleteDoc) from there.
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// A physical shot — the actual injection/dose given, which is the real unit of proof (one brand,
// one batch, one photo of the vial/slip). One or more VaccineDose schedule line items point here
// via doseGroupId; a vaccine only counts as "given" once it's assigned to a shot — LogVaccineVisit
// no longer offers brand/batch/photo on the individual vaccine at all, only on the shot itself.
// Never referenced from more than one visit's doses at a time in practice (a shot only ever gets
// built within a single Log Visit session), but nothing here enforces that beyond the UI's own flow.
export interface VaccineDoseGroup {
  id: string;
  profileId: string;
  ownerUid: string;
  name: string; // the shot's own label, e.g. the product name — required even before anything else is filled in
  brand: string | null;
  batchNo: string | null;
  expiryDate: string | null;
  photoFront: string | null;
  photoBack: string | null;
  loggedBy: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// One AI-curated, web-search-sourced suggestion for a shot's name/brand and the vaccines it
// covers — the whole catalog lives in a single doc, vaccineBrandCatalog/current, regenerated
// every 3 months by server.ts's /api/cron/refresh-vaccine-brand-catalog. Purely a suggestion for
// LogVaccineVisit.tsx's "Add a shot" flow — never written by the client, never required.
export interface VaccineBrandCatalogEntry {
  shotName: string;
  brand: string;
  vaccines: string[];
}

// One per (profile, visit) — tracks whether an appointment's been booked for that visit, which is
// what the reminder logic (vaccinationReminders.ts) branches on: booked -> calendar notices
// counting down to it plus one alarm 2h before; not booked -> nudges to book, plus a 9am
// safety-net alarm on the due date itself; explicitly "walk-in" -> skips the nudges, keeps the
// safety-net alarm.
export interface VaccineAppointment {
  id: string; // `${profileId}_${visitKey}`
  profileId: string;
  ownerUid: string;
  visitKey: string;
  visitLabel: string;
  booked: boolean;
  date: string | null; // yyyy-mm-dd
  time: string | null; // HH:mm
  clinic: string | null;
  doctor: string | null;
  walkIn: boolean; // "no appointment needed, I'll just go" — explicit, stops the booking nudges
  updatedAt: string;
  updatedBy: string;
}

// One-line appointment status for a visit — shared by the Dashboard's tile (BabyVaccinations.tsx)
// and the visit detail screen (LogVaccineVisit.tsx), so both describe a given appointment state
// identically. When booked, leads with doctor/clinic (whichever were actually recorded) before the
// date/time, since "who and where" is usually what a parent is scanning the tile for.
export function appointmentSummaryText(appt: VaccineAppointment | undefined, t: (key: string, params?: Record<string, string>) => string): string {
  if (appt?.booked && appt.date && appt.time) {
    const who = [appt.doctor ? `Dr. ${appt.doctor}` : null, appt.clinic].filter(Boolean).join(' · ');
    const when = t('babyVax.appointmentSetFor', { date: appt.date, time: appt.time });
    return who ? `${who} · ${when}` : when;
  }
  if (appt?.walkIn) return t('babyVax.walkInPlanned');
  return t('babyVax.noAppointmentYet');
}

// Caregiver access to a baby profile — same consent-gated shape as healthDelegateInvites.ts
// (a friend-based grant only takes effect once accepted), scoped to one profile instead of a
// medicine "kind". A baby has no account of its own to grant access FROM, so this is owned by
// the profile itself, not modeled as a delegate-of-a-real-person relationship.
export interface BabyCaregiverInvite {
  id: string; // `${profileId}_${caregiverUid}`
  profileId: string;
  profileName: string;
  ownerUid: string;
  caregiverUid: string;
  status: 'pending' | 'accepted' | 'declined';
  ownerName: string;
  ownerPhoto: string;
  createdAt: string;
  respondedAt: string | null;
}

interface MilestoneVaccine {
  name: string;
  dose: number;
  iapOnly?: boolean; // included only when scheduleTemplate === 'iap'
}
interface ScheduleMilestone {
  key: string;
  label: string;
  offsetDays: number; // from date of birth
  vaccines: MilestoneVaccine[];
}

// India — shared milestone list for both 'uip' (government-only, iapOnly vaccines filtered out)
// and 'iap' (the fuller private-pediatrician-recommended schedule, everything included).
const SCHEDULE_INDIA: ScheduleMilestone[] = [
  { key: 'birth', label: 'Birth Dose', offsetDays: 0, vaccines: [
    { name: 'BCG', dose: 0 }, { name: 'OPV', dose: 0 }, { name: 'Hepatitis B', dose: 1 },
  ] },
  { key: '6w', label: '6 Week Visit', offsetDays: 42, vaccines: [
    { name: 'Pentavalent', dose: 1 }, { name: 'OPV', dose: 1 }, { name: 'Rotavirus', dose: 1 }, { name: 'PCV', dose: 1 },
  ] },
  { key: '10w', label: '10 Week Visit', offsetDays: 70, vaccines: [
    { name: 'Pentavalent', dose: 2 }, { name: 'OPV', dose: 2 }, { name: 'Rotavirus', dose: 2 }, { name: 'PCV', dose: 2 },
  ] },
  { key: '14w', label: '14 Week Visit', offsetDays: 98, vaccines: [
    { name: 'Pentavalent', dose: 3 }, { name: 'OPV', dose: 3 }, { name: 'IPV', dose: 1 }, { name: 'Rotavirus', dose: 3 }, { name: 'PCV', dose: 3 },
  ] },
  { key: '6m', label: '6 Month Visit', offsetDays: 180, vaccines: [
    { name: 'Hepatitis A', dose: 1, iapOnly: true }, { name: 'Influenza', dose: 1, iapOnly: true },
  ] },
  { key: '9m', label: '9 Month Visit', offsetDays: 270, vaccines: [
    { name: 'Measles-Rubella', dose: 1 }, { name: 'Vitamin A', dose: 1 },
  ] },
  { key: '12m', label: '12 Month Visit', offsetDays: 365, vaccines: [
    { name: 'Hepatitis A', dose: 2, iapOnly: true },
  ] },
  { key: '15m', label: '15 Month Visit', offsetDays: 456, vaccines: [
    { name: 'MMR', dose: 1, iapOnly: true }, { name: 'Varicella', dose: 1, iapOnly: true }, { name: 'PCV Booster', dose: 1, iapOnly: true },
  ] },
  { key: '16-24m', label: '16–24 Month Visit', offsetDays: 540, vaccines: [
    { name: 'DPT Booster', dose: 1 }, { name: 'OPV Booster', dose: 1 }, { name: 'Measles-Rubella', dose: 2 },
  ] },
  { key: '4-6y', label: '4–6 Year Visit', offsetDays: 1825, vaccines: [
    { name: 'DPT Booster', dose: 2 }, { name: 'OPV Booster', dose: 2 }, { name: 'Varicella', dose: 2, iapOnly: true }, { name: 'Typhoid', dose: 1, iapOnly: true },
  ] },
  { key: '10-12y', label: '10–12 Year Visit', offsetDays: 3800, vaccines: [
    { name: 'Tdap/Td', dose: 1 }, { name: 'HPV', dose: 1, iapOnly: true },
  ] },
];

// United States — loosely modeled on the CDC's routine childhood schedule.
const SCHEDULE_CDC: ScheduleMilestone[] = [
  { key: 'birth', label: 'Birth Dose', offsetDays: 0, vaccines: [{ name: 'Hepatitis B', dose: 1 }] },
  { key: '2m', label: '2 Month Visit', offsetDays: 60, vaccines: [
    { name: 'DTaP', dose: 1 }, { name: 'IPV', dose: 1 }, { name: 'Hib', dose: 1 }, { name: 'PCV13', dose: 1 }, { name: 'Rotavirus', dose: 1 }, { name: 'Hepatitis B', dose: 2 },
  ] },
  { key: '4m', label: '4 Month Visit', offsetDays: 120, vaccines: [
    { name: 'DTaP', dose: 2 }, { name: 'IPV', dose: 2 }, { name: 'Hib', dose: 2 }, { name: 'PCV13', dose: 2 }, { name: 'Rotavirus', dose: 2 },
  ] },
  { key: '6m', label: '6 Month Visit', offsetDays: 180, vaccines: [
    { name: 'DTaP', dose: 3 }, { name: 'Hib', dose: 3 }, { name: 'PCV13', dose: 3 }, { name: 'Rotavirus', dose: 3 }, { name: 'Hepatitis B', dose: 3 }, { name: 'Influenza', dose: 1 },
  ] },
  { key: '12m', label: '12 Month Visit', offsetDays: 365, vaccines: [
    { name: 'Hib', dose: 4 }, { name: 'PCV13', dose: 4 }, { name: 'MMR', dose: 1 }, { name: 'Varicella', dose: 1 }, { name: 'Hepatitis A', dose: 1 },
  ] },
  { key: '15-18m', label: '15–18 Month Visit', offsetDays: 500, vaccines: [
    { name: 'DTaP', dose: 4 }, { name: 'Hepatitis A', dose: 2 },
  ] },
  { key: '4-6y', label: '4–6 Year Visit', offsetDays: 1825, vaccines: [
    { name: 'DTaP', dose: 5 }, { name: 'IPV', dose: 4 }, { name: 'MMR', dose: 2 }, { name: 'Varicella', dose: 2 },
  ] },
  { key: '11-12y', label: '11–12 Year Visit', offsetDays: 4015, vaccines: [
    { name: 'Tdap', dose: 1 }, { name: 'HPV', dose: 1 }, { name: 'MenACWY', dose: 1 },
  ] },
];

// United Kingdom — loosely modeled on the NHS routine immunisation schedule.
const SCHEDULE_NHS: ScheduleMilestone[] = [
  { key: '8w', label: '8 Week Visit', offsetDays: 56, vaccines: [
    { name: '6-in-1 (DTaP/IPV/Hib/HepB)', dose: 1 }, { name: 'MenB', dose: 1 }, { name: 'Rotavirus', dose: 1 },
  ] },
  { key: '12w', label: '12 Week Visit', offsetDays: 84, vaccines: [
    { name: '6-in-1 (DTaP/IPV/Hib/HepB)', dose: 2 }, { name: 'PCV', dose: 1 }, { name: 'Rotavirus', dose: 2 },
  ] },
  { key: '16w', label: '16 Week Visit', offsetDays: 112, vaccines: [
    { name: '6-in-1 (DTaP/IPV/Hib/HepB)', dose: 3 }, { name: 'MenB', dose: 2 },
  ] },
  { key: '1y', label: '1 Year Visit', offsetDays: 365, vaccines: [
    { name: 'Hib/MenC', dose: 1 }, { name: 'MMR', dose: 1 }, { name: 'PCV Booster', dose: 1 }, { name: 'MenB Booster', dose: 1 },
  ] },
  { key: '3y4m', label: '3 Year 4 Month Visit', offsetDays: 1220, vaccines: [
    { name: 'MMR', dose: 2 }, { name: '4-in-1 Preschool Booster (DTaP/IPV)', dose: 1 },
  ] },
  { key: '12-13y', label: '12–13 Year Visit', offsetDays: 4550, vaccines: [{ name: 'HPV', dose: 1 }] },
  { key: '14y', label: '14 Year Visit', offsetDays: 5110, vaccines: [
    { name: '3-in-1 Teenage Booster (Td/IPV)', dose: 1 }, { name: 'MenACWY', dose: 1 },
  ] },
];

// Generic reference schedule for any country without its own named template — loosely modeled on
// WHO's Expanded Programme on Immunization (EPI). Offered as 'who' whenever a country isn't one of
// the specifically-named ones above.
const SCHEDULE_WHO: ScheduleMilestone[] = [
  { key: 'birth', label: 'Birth Dose', offsetDays: 0, vaccines: [
    { name: 'BCG', dose: 0 }, { name: 'OPV', dose: 0 }, { name: 'Hepatitis B', dose: 1 },
  ] },
  { key: '6w', label: '6 Week Visit', offsetDays: 42, vaccines: [
    { name: 'DTP-HepB-Hib', dose: 1 }, { name: 'OPV', dose: 1 }, { name: 'PCV', dose: 1 }, { name: 'Rotavirus', dose: 1 },
  ] },
  { key: '10w', label: '10 Week Visit', offsetDays: 70, vaccines: [
    { name: 'DTP-HepB-Hib', dose: 2 }, { name: 'OPV', dose: 2 }, { name: 'PCV', dose: 2 }, { name: 'Rotavirus', dose: 2 },
  ] },
  { key: '14w', label: '14 Week Visit', offsetDays: 98, vaccines: [
    { name: 'DTP-HepB-Hib', dose: 3 }, { name: 'OPV', dose: 3 }, { name: 'IPV', dose: 1 }, { name: 'PCV', dose: 3 },
  ] },
  { key: '9m', label: '9 Month Visit', offsetDays: 270, vaccines: [
    { name: 'Measles', dose: 1 }, { name: 'Vitamin A', dose: 1 },
  ] },
  { key: '15-18m', label: '15–18 Month Visit', offsetDays: 500, vaccines: [
    { name: 'Measles', dose: 2 }, { name: 'DTP Booster', dose: 1 },
  ] },
];

const SCHEDULES_BY_TEMPLATE: Record<Exclude<ScheduleTemplate, 'blank'>, ScheduleMilestone[]> = {
  uip: SCHEDULE_INDIA, iap: SCHEDULE_INDIA, cdc: SCHEDULE_CDC, nhs: SCHEDULE_NHS, who: SCHEDULE_WHO,
};

function addDaysLocal(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Generates every dose the chosen template implies for a given date of birth — the schedule is
// entirely derived, never hand-typed by the parent (that's the whole point of picking a template
// at profile creation). 'blank' generates nothing; doses are then added one at a time like a
// medicine, via LogVaccineVisit's "add another vaccine" escape hatch.
export function generateScheduleDoses(dob: string, template: ScheduleTemplate): Array<{
  visitKey: string; visitLabel: string; dueDate: string; vaccineName: string; doseNumber: number;
}> {
  if (template === 'blank') return [];
  const out: Array<{ visitKey: string; visitLabel: string; dueDate: string; vaccineName: string; doseNumber: number }> = [];
  for (const milestone of SCHEDULES_BY_TEMPLATE[template]) {
    const vaccines = milestone.vaccines.filter((v) => template === 'iap' || !v.iapOnly);
    if (vaccines.length === 0) continue;
    const dueDate = addDaysLocal(dob, milestone.offsetDays);
    vaccines.forEach((v) => out.push({ visitKey: milestone.key, visitLabel: milestone.label, dueDate, vaccineName: v.name, doseNumber: v.dose }));
  }
  return out;
}

export function babyCaregiverInviteId(profileId: string, caregiverUid: string): string {
  return `${profileId}_${caregiverUid}`;
}

export function vaccineAppointmentId(profileId: string, visitKey: string): string {
  return `${profileId}_${visitKey}`;
}

// Age-in-weeks/months display, e.g. "10 weeks old" / "6 months old" / "2 years old" — mirrors how
// the mockup and the real Medicines screen both phrase a person's age.
export function ageLabel(dob: string, asOf: Date = new Date()): string {
  const [y, m, d] = dob.split('-').map(Number);
  const birth = new Date(y, m - 1, d);
  const days = Math.floor((asOf.getTime() - birth.getTime()) / 86400000);
  if (days < 0) return 'not yet born';
  if (days < 70) return `${Math.floor(days / 7)} weeks old`;
  if (days < 730) return `${Math.floor(days / 30.44)} months old`;
  return `${Math.floor(days / 365.25)} years old`;
}
