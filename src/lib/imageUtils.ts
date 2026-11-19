// Resizes an image file down to fit within maxWidth/maxHeight (preserving aspect ratio) and
// returns it as a JPEG data URL. Used to keep base64-encoded images (stored directly in
// Firestore documents, no Storage bucket in this app) comfortably under the 1MB doc limit.
export function resizeImageFile(file: File, maxWidth = 1000, maxHeight = 1000, quality = 0.6): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = event.target?.result as string;
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else if (height > maxHeight) {
          width *= maxHeight / height;
          height = maxHeight;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
    };
  });
}

// Compresses an attached photo (a receipt, a bill) so it stays READABLE: it keeps as much resolution and quality as fits `maxChars`
// (the base64 length it may take of the 1MB document), and only shrinks further when the photo would not fit. A fixed small size
// (900px / quality 0.5) turned long bills into unreadable blur, because a tall receipt photo has very little resolution per line of text.
export function resizeImageToBudget(file: File, maxChars: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = event.target?.result as string;
      img.onload = () => {
        const sides = [2000, 1700, 1450, 1250, 1050, 900];
        const qualities = [0.82, 0.72, 0.62];
        let last = '';
        const longest = Math.max(img.width, img.height);
        for (const side of sides) {
          const scale = Math.min(1, side / longest);
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('Canvas not available')); return; }
          ctx.fillStyle = '#ffffff'; // transparent PNGs would turn black in a JPEG
          ctx.fillRect(0, 0, w, h);
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);
          for (const q of qualities) {
            last = canvas.toDataURL('image/jpeg', q);
            if (last.length <= maxChars) { resolve(last); return; }
          }
        }
        resolve(last);
      };
    };
  });
}

// How much of the document's photo budget each new photo may use: a single receipt gets a generous share, and a batch splits what is left.
export function photoBudgetChars(totalMax: number, usedChars: number, newCount: number): number {
  const left = Math.max(0, totalMax - usedChars);
  return Math.max(120_000, Math.min(450_000, Math.floor(left / Math.max(newCount, 2))));
}
