import React from 'react';
import { resizeImageFile } from '../lib/imageUtils';
import ImageLightbox from './ImageLightbox';

// Safety margin under Firestore's 1MB document cap, leaving room for every other field on the
// doc — same reasoning as Feedback.tsx's single-screenshot 1MB check, just budgeted for
// multiple images sharing one document.
const MAX_TOTAL_BYTES = 900_000;

interface ImageAttachmentsProps {
  images: string[];
  onChange: (images: string[]) => void;
  maxImages?: number;
  label?: string;
}

// Shared "attach photos" control for item-creation forms (Add Expense, To-Do, Recurring
// Expenses, Scheduled reminders). Every image is compressed client-side via resizeImageFile and
// stored as a base64 JPEG data URI directly on the document — this app has no Storage bucket,
// every other image field (Feedback's screenshot, AdminBroadcast's images, profile/group
// photos) already follows that same convention, so this does too rather than introducing a new
// upload path. Resized smaller (900px/quality 0.5) than the single-image default in
// imageUtils.ts since several of these can share one document.
export default function ImageAttachments({ images, onChange, maxImages = 3, label = 'Add photo' }: ImageAttachmentsProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [processing, setProcessing] = React.useState(false);
  const [lightboxSrc, setLightboxSrc] = React.useState<string | null>(null);

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    setError(null);
    const toProcess = files.slice(0, Math.max(0, maxImages - images.length));
    if (toProcess.length === 0) return;
    setProcessing(true);
    try {
      const resized = await Promise.all(toProcess.map((f) => resizeImageFile(f, 900, 900, 0.5)));
      const next = [...images, ...resized];
      if (next.reduce((sum, s) => sum + s.length, 0) > MAX_TOTAL_BYTES) {
        setError('These photos are too large even after compression — try fewer or smaller images.');
        return;
      }
      onChange(next);
    } catch (err) {
      console.error('Image resize failed:', err);
      setError('Could not process one of those images. Please try another.');
    } finally {
      setProcessing(false);
    }
  };

  const removeAt = (i: number) => onChange(images.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div key={i} className="relative">
              {/* Its own sibling button, sized to the image — the remove button below is
                  position:absolute so it always paints (and hit-tests) above this one wherever
                  they visually overlap, meaning a tap on the small corner badge can never fall
                  through to "view" and vice versa. */}
              <button type="button" onClick={() => setLightboxSrc(src)} className="block">
                <img src={src} alt="" className="w-16 h-16 object-cover rounded-xl border border-border-subtle" />
              </button>
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-white rounded-full shadow-md border border-border-subtle flex items-center justify-center text-error"
                aria-label="Remove photo"
              >
                <span className="material-symbols-outlined text-[12px]">close</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {images.length < maxImages && (
        <label className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-border-subtle text-xs font-bold text-primary hover:bg-surface ${processing ? 'opacity-60' : 'cursor-pointer'}`}>
          <span className="material-symbols-outlined text-[18px]">add_photo_alternate</span>
          {processing ? 'Processing…' : `${label}${maxImages > 1 ? ` (${images.length}/${maxImages})` : ''}`}
          <input type="file" accept="image/*" multiple={maxImages > 1} className="hidden" onChange={handleFiles} disabled={processing} />
        </label>
      )}
      {error && <p className="text-[11px] text-error font-bold">{error}</p>}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}
