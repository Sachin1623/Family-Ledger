import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, documentId, query, where, writeBatch } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { todayLocalDateString } from '../lib/dateUtils';
import { BabyProfile, VaccineDose, VaccineDoseGroup, VaccineAppointment, vaccineAppointmentId, appointmentSummaryText, ageLabel, DEFAULT_REMINDER_PREFS, COUNTRIES, DEFAULT_COUNTRY, TEMPLATE_META } from '../lib/vaccinations';
import { scheduleVaccineReminders, cancelVaccineReminders, groupDosesIntoVisits, VisitGroup } from '../lib/vaccinationReminders';
import { usePageFabAction } from '../context/FabActionContext';
import { shareOrDownloadFile } from '../lib/fileShare';
import ImageLightbox from '../components/ImageLightbox';

const ACTIVE_BABY_PROFILE_KEY = 'familyledger_active_baby_profile';

function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    img.onerror = () => resolve({ width: 1, height: 1 });
    img.src = dataUrl;
  });
}

export default function BabyVaccinations() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const today = todayLocalDateString();

  const [ownProfilesValue] = useCollection(user ? query(collection(db, 'babyProfiles'), where('ownerUid', '==', user.uid)) : null);
  const [myCaregiverInvitesValue] = useCollection(
    user ? query(collection(db, 'babyCaregiverInvites'), where('caregiverUid', '==', user.uid), where('status', '==', 'accepted')) : null,
  );
  const caregiverProfileIds = useMemo(
    () => (myCaregiverInvitesValue?.docs || []).map((d) => d.data().profileId as string),
    [myCaregiverInvitesValue],
  );
  const [caregiverProfilesValue] = useCollection(
    caregiverProfileIds.length > 0 ? query(collection(db, 'babyProfiles'), where(documentId(), 'in', caregiverProfileIds.slice(0, 30))) : null,
  );
  // Soft-deleted babies are excluded here — they only ever show up in the separate Deleted Babies
  // list (VaccineDeletedBabies.tsx), which re-queries the same two collections itself rather than
  // sharing this filtered list.
  const profiles: BabyProfile[] = useMemo(() => {
    const byId = new Map<string, BabyProfile>();
    ownProfilesValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    caregiverProfilesValue?.docs.forEach((d) => byId.set(d.id, { id: d.id, ...(d.data() as any) }));
    return Array.from(byId.values()).filter((p) => !p.deletedAt);
  }, [ownProfilesValue, caregiverProfilesValue]);
  // Deleting a baby is owner-only (VaccineProfileView.tsx), so only OWN profiles can ever end up
  // here — same scope VaccineDeletedBabies.tsx itself queries. Drives whether the picker row's
  // trailing "Deleted Kids" chip shows at all.
  const hasDeletedBabies = useMemo(
    () => (ownProfilesValue?.docs || []).some((d) => !!(d.data() as any).deletedAt),
    [ownProfilesValue],
  );

  // Remembered across visits (and across this screen's own remounts — navigating to a visit/dose
  // and back unmounts and remounts BabyVaccinations, which used to reset activeProfileId to null
  // and silently fall back to profiles[0] every single time, "forgetting" whichever baby was
  // actually selected). Same localStorage "remember the last selection" pattern Dashboard.tsx uses
  // for its own expand/collapse state.
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_BABY_PROFILE_KEY); } catch { return null; }
  });
  useEffect(() => {
    if (profiles.length === 0) return;
    if (activeProfileId && profiles.some((p) => p.id === activeProfileId)) return;
    // Nothing remembered yet, or the remembered id no longer belongs to this user (profile
    // deleted, or caregiver access to it was revoked) — fall back to the first profile.
    setActiveProfileId(profiles[0].id);
  }, [profiles, activeProfileId]);
  useEffect(() => {
    if (!activeProfileId) return;
    try { localStorage.setItem(ACTIVE_BABY_PROFILE_KEY, activeProfileId); } catch { /* ignore */ }
  }, [activeProfileId]);
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || null;

  const [dosesValue] = useCollection(activeProfileId ? query(collection(db, 'vaccineDoses'), where('profileId', '==', activeProfileId)) : null);
  const doses: VaccineDose[] = useMemo(() => (dosesValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) })), [dosesValue]);
  const [appointmentsValue] = useCollection(activeProfileId ? query(collection(db, 'vaccineAppointments'), where('profileId', '==', activeProfileId)) : null);
  const appointmentsById = useMemo(() => {
    const m = new Map<string, VaccineAppointment>();
    (appointmentsValue?.docs || []).forEach((d) => m.set(d.id, { id: d.id, ...(d.data() as any) }));
    return m;
  }, [appointmentsValue]);
  // Dose groups this profile's doses reference (see VaccineDoseGroup) — a grouped dose's own
  // brand/batch/expiry/photo are null, so the PDF export below reads proof from here instead.
  const [doseGroupsValue] = useCollection(activeProfileId ? query(collection(db, 'vaccineDoseGroups'), where('profileId', '==', activeProfileId)) : null);
  const groupsById = useMemo(() => {
    const m = new Map<string, VaccineDoseGroup>();
    (doseGroupsValue?.docs || []).forEach((d) => m.set(d.id, { id: d.id, ...(d.data() as any) }));
    return m;
  }, [doseGroupsValue]);

  // Groups a flat dose list into one VisitGroup per visitKey — shared by the live (non-deleted)
  // buckets below and by the Deleted section, which groups the deleted doses the exact same way.
  const groupIntoVisits = (doseList: VaccineDose[]): VisitGroup[] => {
    if (!activeProfile) return [];
    const byKey = new Map<string, VisitGroup>();
    doseList.forEach((d) => {
      if (!byKey.has(d.visitKey)) {
        byKey.set(d.visitKey, {
          profileId: activeProfile.id, profileName: activeProfile.name, visitKey: d.visitKey,
          visitLabel: d.visitLabel, dueDate: d.dueDate, doses: [],
          reminderPrefs: activeProfile.reminderPrefs || DEFAULT_REMINDER_PREFS,
        });
      }
      byKey.get(d.visitKey)!.doses.push(d);
    });
    return Array.from(byKey.values()).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  };

  const visits: VisitGroup[] = useMemo(
    () => groupIntoVisits(doses.filter((d) => !d.deletedAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doses, activeProfile],
  );
  const deletedVisits: VisitGroup[] = useMemo(
    () => groupIntoVisits(doses.filter((d) => d.deletedAt)).sort((a, b) => {
      const aAt = a.doses[0]?.deletedAt || '';
      const bAt = b.doses[0]?.deletedAt || '';
      return bAt.localeCompare(aAt); // most recently deleted first
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doses, activeProfile],
  );

  const overdueVisits = visits.filter((v) => v.doses.some((d) => d.status === 'pending') && v.dueDate < today);
  const upcomingVisits = visits.filter((v) => v.doses.some((d) => d.status === 'pending') && v.dueDate >= today);
  const historyVisits = visits.filter((v) => v.doses.every((d) => d.status !== 'pending'));

  // Reconcile native reminders across EVERY profile in `profiles` (own + caregiver-accessible),
  // not just whichever one is "active" in this screen right now — scheduleVaccineReminders does a
  // "cancel everything, reschedule from current state" pass over a single shared set of alarm/
  // notification ids (see its own header comment), so reconciling with only the active profile's
  // visits would silently cancel every OTHER profile's already-armed alarms the moment this effect
  // ran. Mirrors HealthMedicines.tsx's own belt-and-suspenders call, which likewise always passes
  // its FULL own+delegate medicine set rather than whatever's currently selected in that screen's
  // UI. GlobalVaccineReminderScheduler.tsx (mounted at the app root) does this same full reconcile
  // on every session regardless of which screen is open; this call just keeps things in sync
  // immediately while this screen happens to be open too.
  const profileIds = useMemo(() => profiles.map((p) => p.id), [profiles]);
  const [allDosesValue] = useCollection(
    profileIds.length > 0 ? query(collection(db, 'vaccineDoses'), where('profileId', 'in', profileIds.slice(0, 30))) : null,
  );
  const [allAppointmentsValue] = useCollection(
    profileIds.length > 0 ? query(collection(db, 'vaccineAppointments'), where('profileId', 'in', profileIds.slice(0, 30))) : null,
  );
  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const allVisits = useMemo(() => {
    const liveDoses = (allDosesValue?.docs || [])
      .map((d) => ({ id: d.id, ...(d.data() as any) }) as VaccineDose)
      .filter((d) => !d.deletedAt);
    return groupDosesIntoVisits(liveDoses, profilesById);
  }, [allDosesValue, profilesById]);
  const allAppointmentsById = useMemo(() => {
    const m = new Map<string, VaccineAppointment>();
    (allAppointmentsValue?.docs || []).forEach((d) => m.set(d.id, { id: d.id, ...(d.data() as any) }));
    return m;
  }, [allAppointmentsValue]);
  useEffect(() => {
    scheduleVaccineReminders(allVisits, allAppointmentsById);
  }, [allVisits, allAppointmentsById]);

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const handleRestoreVisit = async (v: VisitGroup) => {
    if (!user) return;
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      v.doses.forEach((d) => batch.update(doc(db, 'vaccineDoses', d.id), { deletedAt: null, loggedBy: user.uid, updatedAt: now }));
      await batch.commit();
    } catch (err) {
      console.error('Failed to restore visit:', err);
      alert(t('babyVax.saveVisitFailed'));
    }
  };

  const handlePermanentlyDeleteVisit = async (v: VisitGroup) => {
    if (!window.confirm(t('babyVax.confirmDeleteVisitPermanently'))) return;
    try {
      const batch = writeBatch(db);
      v.doses.forEach((d) => batch.delete(doc(db, 'vaccineDoses', d.id)));
      await batch.commit();
      // Belt-and-suspenders alongside the reactive reconcile effect above — cancels this visit's
      // native alarm immediately rather than waiting on a re-render to notice it's gone, so a
      // stale alarm can't ring for a visit that's already been removed.
      await cancelVaccineReminders();
    } catch (err) {
      console.error('Failed to permanently delete visit:', err);
      alert(t('babyVax.saveVisitFailed'));
    }
  };

  const [exportingReport, setExportingReport] = useState(false);

  // Branded PDF report — grouped per visit (not per vaccine), each dose showing its administered
  // date, expiry, brand/batch, clinic/doctor, and any photographed vaccination slip. Only given
  // doses are included; a visit with nothing given yet has nothing to report. Mirrors the
  // established jsPDF branding pattern from HealthMedicines.tsx's own PDF export (top-right
  // "FamilyLedger" wordmark + Play Store badge, same footer), but built with direct text/image
  // calls instead of autoTable, since each dose needs its own variable-height card for photos.
  const handleExportReport = async () => {
    if (!activeProfile) return;
    const givenVisits = visits
      .map((v) => ({ ...v, doses: v.doses.filter((d) => d.status === 'given') }))
      .filter((v) => v.doses.length > 0)
      .sort((a, b) => (a.doses[0].givenDate || a.dueDate).localeCompare(b.doses[0].givenDate || b.dueDate));
    if (givenVisits.length === 0) {
      alert(t('health.noDataToExport'));
      return;
    }
    setExportingReport(true);
    try {
      const { default: jsPDF } = await import('jspdf');

      // Every photo's natural pixel size, needed to fit each thumbnail into its box without
      // distorting it — loaded up front so the actual PDF drawing below can stay synchronous.
      const photoSizes = new Map<string, { width: number; height: number }>();
      for (const v of givenVisits) {
        for (const d of v.doses) {
          const proof = d.doseGroupId ? groupsById.get(d.doseGroupId) : d;
          if (proof?.photoFront) photoSizes.set(`${d.id}_front`, await loadImageSize(proof.photoFront));
          if (proof?.photoBack) photoSizes.set(`${d.id}_back`, await loadImageSize(proof.photoBack));
        }
      }

      const docPdf = new jsPDF();
      const brandColor: [number, number, number] = [15, 71, 97];
      const webUrl = 'https://familyledger.thirteenapps.com/';
      const androidUrl = 'https://play.google.com/store/apps/details?id=com.familyledger.app';
      const pageWidth = docPdf.internal.pageSize.getWidth();
      const marginX = 14;
      const footerY = 291;
      const bottomLimit = footerY - 6;
      let y = 38;

      const drawHeader = () => {
        docPdf.setFontSize(13);
        docPdf.setTextColor(...brandColor);
        docPdf.setFont('helvetica', 'bold');
        docPdf.text('FamilyLedger', pageWidth - marginX, 14, { align: 'right' });
        docPdf.setFont('helvetica', 'normal');
        const badgeLabel = 'Get it on Google Play';
        const badgeY = 19;
        docPdf.setFontSize(8);
        const badgeTextWidth = docPdf.getTextWidth(badgeLabel);
        const iconSize = 3;
        const iconGap = 1.5;
        const badgeWidth = iconSize + iconGap + badgeTextWidth;
        const badgeStartX = pageWidth - marginX - badgeWidth;
        docPdf.setFillColor(...brandColor);
        docPdf.triangle(badgeStartX, badgeY - iconSize / 2, badgeStartX, badgeY + iconSize / 2, badgeStartX + iconSize, badgeY, 'F');
        docPdf.text(badgeLabel, badgeStartX + iconSize + iconGap, badgeY + 1.3);
        docPdf.link(badgeStartX - 1, badgeY - 3, badgeWidth + 2, 6, { url: androidUrl });
      };

      drawHeader();
      docPdf.setFontSize(16);
      docPdf.setTextColor(0);
      docPdf.text(t('babyVax.reportTitle'), marginX, 18);
      const countryLabel = COUNTRIES.find((c) => c.id === (activeProfile.country || DEFAULT_COUNTRY))?.label || '';
      const templateLabel = t(TEMPLATE_META[activeProfile.scheduleTemplate]?.titleKey || 'babyVax.templateBlank');
      docPdf.setFontSize(9);
      docPdf.setTextColor(120);
      docPdf.text(`${activeProfile.name} · DOB ${activeProfile.dob}${activeProfile.babyBloodGroup ? ` · Blood group ${activeProfile.babyBloodGroup}` : ''}`, marginX, 24);
      docPdf.text(`Schedule: ${templateLabel} (${countryLabel}) — Generated via FamilyLedger — ${new Date().toLocaleString()}`, marginX, 29);
      docPdf.setTextColor(90);
      docPdf.setFontSize(7.5);
      const disclaimerLines = docPdf.splitTextToSize(t('babyVax.scheduleDisclaimer'), pageWidth - marginX * 2);
      docPdf.text(disclaimerLines, marginX, 34);
      docPdf.setTextColor(0);

      const ensureSpace = (needed: number) => {
        if (y + needed > bottomLimit) {
          docPdf.addPage();
          drawHeader();
          y = 20;
        }
      };

      for (const v of givenVisits) {
        ensureSpace(16);
        docPdf.setFillColor(...brandColor);
        docPdf.roundedRect(marginX, y, pageWidth - marginX * 2, 9, 1.5, 1.5, 'F');
        docPdf.setTextColor(255);
        docPdf.setFont('helvetica', 'bold');
        docPdf.setFontSize(10);
        docPdf.text(v.visitLabel, marginX + 3, y + 6);
        docPdf.setFont('helvetica', 'normal');
        docPdf.setFontSize(8);
        docPdf.text(v.doses[0].givenDate || v.dueDate, pageWidth - marginX - 3, y + 6, { align: 'right' });
        y += 9 + 2;
        docPdf.setTextColor(0);

        // Clinic/doctor can be recorded two places — typed once per visit in LogVaccineVisit's
        // shared fields (copied onto every dose saved with that visit), or entered earlier when
        // booking the appointment (vaccineAppointments). A visit logged straight from a booked
        // appointment without retyping those fields would otherwise print blank here even though
        // the clinic/doctor were recorded — so this falls back to the appointment's values too.
        const apptForVisit = appointmentsById.get(vaccineAppointmentId(v.profileId, v.visitKey));
        const sharedClinic = v.doses.find((d) => d.clinic)?.clinic || apptForVisit?.clinic || null;
        const sharedDoctor = v.doses.find((d) => d.doctor)?.doctor || apptForVisit?.doctor || null;
        if (sharedClinic || sharedDoctor) {
          ensureSpace(6);
          docPdf.setFontSize(8.5);
          docPdf.setFont('helvetica', 'bold');
          docPdf.setTextColor(90);
          docPdf.text(`${sharedClinic ? `Clinic: ${sharedClinic}` : ''}${sharedClinic && sharedDoctor ? '   ·   ' : ''}${sharedDoctor ? `Dr. ${sharedDoctor}` : ''}`, marginX + 1, y);
          docPdf.setFont('helvetica', 'normal');
          docPdf.setTextColor(0);
          y += 5;
        }

        for (const d of v.doses) {
          // A grouped dose's own brand/batch/expiry/photo are null — its proof lives on the shared
          // vaccineDoseGroups doc instead (one shot covering several vaccine names at once).
          const proof = d.doseGroupId ? groupsById.get(d.doseGroupId) : d;
          const siblingNames = d.doseGroupId ? v.doses.filter((other) => other.id !== d.id && other.doseGroupId === d.doseGroupId).map((other) => other.vaccineName) : [];
          const frontSize = proof?.photoFront ? photoSizes.get(`${d.id}_front`) : null;
          const backSize = proof?.photoBack ? photoSizes.get(`${d.id}_back`) : null;
          const hasPhotos = !!(frontSize || backSize);
          const photoBoxSize = 24;
          const cardW = pageWidth - marginX * 2;
          const textAreaWidth = cardW - (hasPhotos ? photoBoxSize * 2 + 10 : 6) - 6;
          const notesLines = d.notes ? docPdf.splitTextToSize(d.notes, textAreaWidth) : [];
          const linkedLines = siblingNames.length > 0 ? docPdf.splitTextToSize(`Same dose as: ${siblingNames.join(', ')}`, textAreaWidth) : [];
          let cardHeight = 5 + 4.5 + 4.5 + 4.5 + 2 + (linkedLines.length > 0 ? linkedLines.length * 3.6 + 1 : 0) + (notesLines.length > 0 ? notesLines.length * 3.6 + 1 : 0);
          if (hasPhotos) cardHeight = Math.max(cardHeight, photoBoxSize + 6);
          ensureSpace(cardHeight + 4);

          docPdf.setDrawColor(220);
          docPdf.roundedRect(marginX, y, cardW, cardHeight, 1.5, 1.5);

          const textX = marginX + 3;
          let ty = y + 5;
          const titleText = `${d.vaccineName}${d.doseNumber ? ` · Dose ${d.doseNumber}` : ''}`;
          docPdf.setFont('helvetica', 'bold');
          docPdf.setFontSize(9.5);
          docPdf.text(titleText, textX, ty);
          if ((d.source || 'template') === 'custom') {
            const w = docPdf.getTextWidth(titleText);
            docPdf.setFontSize(6.5);
            docPdf.setTextColor(...brandColor);
            docPdf.text('CUSTOM', textX + w + 3, ty);
            docPdf.setTextColor(0);
          }
          docPdf.setFont('helvetica', 'normal');
          docPdf.setFontSize(8);
          ty += 4.5;
          docPdf.text(`Administered: ${d.givenDate || '—'}`, textX, ty);
          ty += 4.5;
          docPdf.text(`Expiry: ${proof?.expiryDate || 'Not recorded'}`, textX, ty);
          ty += 4.5;
          docPdf.text(`Brand: ${proof?.brand || '—'}   Batch: ${proof?.batchNo || '—'}`, textX, ty);
          if (linkedLines.length > 0) {
            ty += 4.5;
            docPdf.setTextColor(...brandColor);
            docPdf.text(linkedLines, textX, ty);
            docPdf.setTextColor(0);
          }
          if (notesLines.length > 0) {
            ty += 4.5;
            docPdf.setTextColor(120);
            docPdf.text(notesLines, textX, ty);
            docPdf.setTextColor(0);
          }

          if (hasPhotos) {
            let px = marginX + cardW - 3;
            const drawPhoto = (dataUrl: string, size: { width: number; height: number }) => {
              let w = photoBoxSize;
              let h = photoBoxSize * (size.height / size.width);
              if (h > photoBoxSize) { h = photoBoxSize; w = photoBoxSize * (size.width / size.height); }
              px -= w;
              docPdf.addImage(dataUrl, 'JPEG', px, y + (cardHeight - h) / 2, w, h);
              docPdf.setDrawColor(220);
              docPdf.rect(px, y + (cardHeight - h) / 2, w, h);
              px -= 2;
            };
            if (proof?.photoBack && backSize) drawPhoto(proof.photoBack, backSize);
            if (proof?.photoFront && frontSize) drawPhoto(proof.photoFront, frontSize);
          }

          y += cardHeight + 3;
        }
        y += 3;
      }

      const totalPages = docPdf.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        docPdf.setPage(i);
        docPdf.setFontSize(7);
        docPdf.setTextColor(150);
        docPdf.text(`${activeProfile.name} · FamilyLedger — Web: ${webUrl}  ·  Android: ${androidUrl}`, marginX, footerY);
      }

      const pdfBlob = docPdf.output('blob') as Blob;
      const safeName = activeProfile.name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'child';
      await shareOrDownloadFile(pdfBlob, `vaccination_report_${safeName}_${today}.pdf`, 'application/pdf');
    } catch (err) {
      console.error('Vaccination report PDF export failed:', err);
      alert(t('health.exportFailed'));
    } finally {
      setExportingReport(false);
    }
  };

  usePageFabAction('💉', t('babyVax.logVisit'), () => {
    const target = overdueVisits[0] || upcomingVisits[0];
    if (target) navigate(`/baby-vaccinations/log-visit/${target.profileId}/${target.visitKey}`);
  });

  if (profiles.length === 0) {
    return (
      <div className="flex flex-col min-h-screen bg-surface">
        <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full">
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm p-8 text-center space-y-3 mt-6">
            <span className="text-4xl block">👶</span>
            <p className="text-sm font-bold text-on-surface">{t('babyVax.emptyTitle')}</p>
            <p className="text-xs text-text-muted">{t('babyVax.emptyDesc')}</p>
            <button type="button" onClick={() => navigate('/baby-vaccinations/add-child')} className="mt-2 px-5 py-2.5 bg-primary text-white font-bold rounded-xl text-sm">
              {t('babyVax.addChildCta')}
            </button>
          </div>
          {hasDeletedBabies && (
            <button type="button" onClick={() => navigate('/baby-vaccinations/deleted-babies')} className="w-full mt-4 text-[11px] font-bold text-text-muted flex items-center justify-center gap-1">
              <span className="material-symbols-outlined text-[14px]">delete</span>
              {t('babyVax.deletedBabies')}
            </button>
          )}
        </main>
      </div>
    );
  }

  return (
    // A genuinely bounded, self-contained scroll region (not min-h-screen) — the old pattern let
    // the fixed bottom Navigation bar overlap the last section (History, usually) whenever the
    // page's rendered content didn't push far enough past the nav's own footprint to reveal it via
    // scrolling. Same fix already applied to HealthGlucose/HealthBloodPressure/HealthMedicines.
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <div className="shrink-0 p-4 md:p-8 pb-2 max-w-xl mx-auto w-full space-y-4">
        <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
          {profiles.map((p) => {
            const isActive = p.id === activeProfileId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setActiveProfileId(p.id)}
                className="flex flex-col items-center gap-1 shrink-0 w-16"
              >
                {p.photo ? (
                  <img src={p.photo} alt="" className={clsx('w-12 h-12 rounded-full object-cover', isActive ? 'border-2 border-primary' : 'border-2 border-transparent opacity-60')} />
                ) : (
                  <div className={clsx('w-12 h-12 rounded-full bg-primary/10 text-primary font-black flex items-center justify-center', isActive ? 'border-2 border-primary' : 'border-2 border-transparent opacity-60')}>
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <span className={clsx('text-[10px] font-bold truncate w-full text-center', isActive ? 'text-primary' : 'text-text-muted')}>{p.name}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => navigate('/baby-vaccinations/add-child')}
            className="flex flex-col items-center gap-1 shrink-0 w-16"
          >
            <div className="w-12 h-12 rounded-full bg-surface-container text-text-muted flex items-center justify-center border-2 border-dashed border-border-subtle">
              <span className="material-symbols-outlined text-[20px]">add</span>
            </div>
            <span className="text-[10px] font-bold text-text-muted truncate w-full text-center">{t('babyVax.addChildCta')}</span>
          </button>
          {hasDeletedBabies && (
            <button
              type="button"
              onClick={() => navigate('/baby-vaccinations/deleted-babies')}
              className="flex flex-col items-center gap-1 shrink-0 w-16"
            >
              <div className="w-12 h-12 rounded-full bg-surface-container text-text-muted flex items-center justify-center border-2 border-transparent">
                <span className="material-symbols-outlined text-[20px]">delete</span>
              </div>
              <span className="text-[10px] font-bold text-text-muted truncate w-full text-center">{t('babyVax.deletedBabies')}</span>
            </button>
          )}
        </div>

        <div className="relative rounded-3xl overflow-hidden bg-gradient-to-br from-primary to-primary-container px-5 pt-5 pb-10">
          <button
            type="button"
            onClick={() => activeProfile?.backgroundPhoto && setLightboxSrc(activeProfile.backgroundPhoto)}
            className="absolute inset-0 w-full h-full"
            aria-label={t('babyVax.backgroundPhoto')}
            disabled={!activeProfile?.backgroundPhoto}
          >
            {activeProfile?.backgroundPhoto ? (
              <img src={activeProfile.backgroundPhoto} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div aria-hidden className="absolute inset-0 opacity-10 text-4xl leading-none select-none pointer-events-none flex flex-wrap content-start gap-5 p-3 -rotate-6 -mx-4 -my-2">
                {Array.from({ length: 14 }).map((_, i) => (
                  <span key={i}>{['🍼', '🧸', '👶', '⭐', '🩹', '🎈'][i % 6]}</span>
                ))}
              </div>
            )}
            {activeProfile?.backgroundPhoto && <div className="absolute inset-0 bg-black/15" />}
          </button>
          <div className="relative flex items-start justify-between gap-2">
            <h1 className="text-xl font-black text-white truncate">{t('babyVax.title')}</h1>
            <div className="flex items-center gap-1.5 shrink-0">
              {activeProfile && (
                <button type="button" onClick={() => navigate(`/baby-vaccinations/reminders/${activeProfile.id}`)} className="w-9 h-9 rounded-full bg-white/15 border border-white/25 flex items-center justify-center text-white" aria-label={t('babyVax.reminders')}>
                  <span className="material-symbols-outlined text-[18px]">notifications</span>
                </button>
              )}
              {activeProfile && (
                <button type="button" onClick={() => navigate(`/baby-vaccinations/caregivers/${activeProfile.id}`)} className="w-9 h-9 rounded-full bg-white/15 border border-white/25 flex items-center justify-center text-white" aria-label={t('babyVax.caregivers')}>
                  <span className="material-symbols-outlined text-[18px]">group</span>
                </button>
              )}
              {activeProfile && (
                <button type="button" onClick={handleExportReport} disabled={exportingReport} className="w-9 h-9 rounded-full bg-white/15 border border-white/25 flex items-center justify-center text-white disabled:opacity-60" aria-label={t('babyVax.downloadReport')}>
                  <span className="material-symbols-outlined text-[18px]">{exportingReport ? 'hourglass_top' : 'picture_as_pdf'}</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {activeProfile && (
          <div className="flex flex-col items-center -mt-9 relative z-10 mb-1">
            <button type="button" onClick={() => activeProfile.photo && setLightboxSrc(activeProfile.photo)}>
              {activeProfile.photo ? (
                <img src={activeProfile.photo} alt="" className="w-16 h-16 rounded-full object-cover border-4 border-white shadow-md" />
              ) : (
                <div className="w-16 h-16 rounded-full bg-white border-4 border-white shadow-md flex items-center justify-center text-primary font-black text-xl">
                  {activeProfile.name.charAt(0).toUpperCase()}
                </div>
              )}
            </button>
            <button type="button" onClick={() => navigate(`/baby-vaccinations/profile/${activeProfile.id}`)} className="flex items-center gap-1 mt-1.5">
              <span className="text-sm font-bold text-primary">{activeProfile.name} · {ageLabel(activeProfile.dob)}</span>
              <span className="material-symbols-outlined text-[13px] text-text-muted">chevron_right</span>
            </button>
            <span className="inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
              {COUNTRIES.find((c) => c.id === (activeProfile.country || DEFAULT_COUNTRY))?.flag} {t(TEMPLATE_META[activeProfile.scheduleTemplate]?.titleKey || 'babyVax.templateBlank')}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-8 pt-0 max-w-xl mx-auto w-full space-y-4 pb-24">
        <div className="bg-primary/5 rounded-2xl p-3 flex gap-2">
          <span className="material-symbols-outlined text-[16px] text-primary shrink-0">info</span>
          <p className="text-[11px] text-primary leading-relaxed">{t('babyVax.scheduleDisclaimer')}</p>
        </div>

        {/* Each status gets its own bordered "card" — one visible box per group, with an internal
            divider between its own tiles — instead of loose individual tiles floating on the page
            background, so where a section starts and ends is unambiguous at a glance. */}
        {overdueVisits.length > 0 && (
          <div className="bg-white rounded-2xl border border-error/25 shadow-sm overflow-hidden">
            <div className="px-3.5 py-2.5 bg-error/5 border-b border-error/20 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px] text-error">warning</span>
              <h2 className="text-[11px] font-black text-error uppercase tracking-wider">{t('babyVax.overdueSection')}</h2>
            </div>
            <div className="divide-y divide-error/10">
              {overdueVisits.map((v) => (
                <div
                  key={v.visitKey}
                  onClick={() => navigate(`/baby-vaccinations/log-visit/${v.profileId}/${v.visitKey}`)}
                  className="p-3.5 cursor-pointer"
                >
                  <p className="text-sm font-black text-error mb-1">{v.visitLabel}</p>
                  <p className="text-xs text-text-muted mb-2">{v.doses.filter((d) => d.status === 'pending').map((d) => `${d.vaccineName}${d.doseNumber ? `·${d.doseNumber}` : ''}`).join(', ')}</p>
                  <p className="text-[11px] font-bold text-error">
                    {appointmentSummaryText(appointmentsById.get(vaccineAppointmentId(v.profileId, v.visitKey)), t)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeProfile && (
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
            <div className="px-3.5 py-2.5 bg-surface border-b border-border-subtle flex items-center justify-between gap-2">
              <h2 className="text-[11px] font-black text-text-muted uppercase tracking-wider">{t('babyVax.upcoming')}</h2>
              <button
                type="button"
                onClick={() => navigate(`/baby-vaccinations/log-visit/${activeProfile.id}/custom_${Date.now()}`)}
                className="shrink-0 flex items-center gap-1 text-[11px] font-bold text-primary"
              >
                <span className="material-symbols-outlined text-[14px]">add</span>
                {t('babyVax.addNewVisit')}
              </button>
            </div>
            {upcomingVisits.length > 0 && (
              <div className="divide-y divide-border-subtle max-h-[480px] overflow-y-auto">
                {upcomingVisits.map((v) => {
                  const appt = appointmentsById.get(vaccineAppointmentId(v.profileId, v.visitKey));
                  return (
                    <div
                      key={v.visitKey}
                      onClick={() => navigate(`/baby-vaccinations/log-visit/${v.profileId}/${v.visitKey}`)}
                      className="p-3.5 cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-bold text-primary">{v.visitLabel}</p>
                        <p className="text-[11px] text-text-muted font-bold">{v.dueDate}</p>
                      </div>
                      <p className="text-[11px] text-text-muted mt-0.5">{v.doses.filter((d) => d.status === 'pending').map((d) => `${d.vaccineName}·${d.doseNumber}`).join(', ')}</p>
                      <p className="text-[10px] font-bold text-primary mt-2">
                        {appointmentSummaryText(appt, t)}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {historyVisits.length > 0 && (
          <div className="bg-white rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
            <div className="px-3.5 py-2.5 bg-surface border-b border-border-subtle">
              <h2 className="text-[11px] font-black text-text-muted uppercase tracking-wider">{t('babyVax.history')}</h2>
            </div>
            <div className="divide-y divide-border-subtle">
              {historyVisits.map((v) => (
                <button
                  type="button"
                  key={v.visitKey}
                  onClick={() => navigate(`/baby-vaccinations/visit/${v.profileId}/${v.visitKey}`)}
                  className="w-full text-left p-3.5 flex items-center gap-3"
                >
                  <span className="w-6 h-6 rounded-full bg-success flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-white text-[14px]">check</span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-primary truncate">{v.visitLabel}</p>
                    <p className="text-[11px] text-text-muted">{v.doses[0]?.givenDate || v.dueDate} · {v.doses.length} {t('babyVax.dosesCount')}</p>
                  </div>
                  <span className="material-symbols-outlined text-[16px] text-text-muted">chevron_right</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {deletedVisits.length > 0 && (
          <div className="bg-surface-container/40 rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
            <div className="px-3.5 py-2.5 bg-surface-container/60 border-b border-border-subtle">
              <h2 className="text-[11px] font-black text-text-muted uppercase tracking-wider">{t('babyVax.deleted')}</h2>
            </div>
            <div className="divide-y divide-border-subtle">
              {deletedVisits.map((v) => (
                <div key={v.visitKey} className="p-3.5">
                  <p className="text-sm font-bold text-text-muted truncate">{v.visitLabel}</p>
                  <p className="text-[11px] text-text-muted mt-0.5">{v.doses.length} {t('babyVax.dosesCount')}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <button type="button" onClick={() => handleRestoreVisit(v)} className="flex-1 py-1.5 bg-primary/5 border border-primary/20 text-primary text-[11px] font-bold rounded-lg flex items-center justify-center gap-1">
                      <span className="material-symbols-outlined text-[14px]">undo</span>
                      {t('babyVax.restoreVisit')}
                    </button>
                    <button type="button" onClick={() => handlePermanentlyDeleteVisit(v)} className="flex-1 py-1.5 bg-white border border-error/30 text-error text-[11px] font-bold rounded-lg">
                      {t('babyVax.deletePermanently')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}
