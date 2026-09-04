// A named health incident/illness ("Post-Surgery Recovery", "Seasonal Flu", "Chronic
// Hypertension") that a set of medicines can be grouped under — promoted from a plain free-text
// tag on Medicine (this app's very first version of this feature) into its own entity once it
// needed a real name + description and its own collapsible section with its own "Add Medicine"
// entry point. Sharing/delegate access mirrors medicines.ts exactly: an incident always belongs to
// one `userId`, a delegate can create/edit it on that person's behalf via `loggedBy`.

export interface MedicalIncident {
  id: string;
  userId: string; // whose incident — a delegate can add/manage it, but it always belongs to this uid
  loggedBy: string; // who actually created/last edited it
  name: string;
  description: string | null;
  // Optional — when set and in the past, this incident stops being offered as a choice on the
  // Add/Edit Medicine form (see isIncidentEnded below), so the picker doesn't grow unbounded as
  // old, resolved incidents pile up over time. The incident itself, and any medicine still
  // referencing it, stays fully visible everywhere else (its own Medicines-tab section, Log/
  // Dashboard filters) — this only trims what's offered when adding something NEW.
  endDate: string | null; // yyyy-mm-dd
  createdAt: string;
}

export function isIncidentEnded(incident: Pick<MedicalIncident, 'endDate'>, todayStr: string): boolean {
  return !!incident.endDate && incident.endDate < todayStr;
}

// The bucket for medicines that aren't tied to any specific incident — not a real Firestore
// document, just a sentinel `incidentId` value HealthMedicines.tsx groups under. Kept as a real
// section (with its own "Add Medicine" button) rather than removed outright, so there's always a
// way to add an ordinary day-to-day medicine without first inventing an incident for it.
export const GENERAL_INCIDENT_ID = '__general__';
