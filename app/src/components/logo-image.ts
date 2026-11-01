/** Match SubIcon's no-referrer request; resolve only after the browser decodes an image. */
export function loadLogoImage(url: string, timeout = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      if (error) {
        img.src = '';
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Logo image timed out')), timeout);
    img.referrerPolicy = 'no-referrer';
    img.onload = () => finish(img.naturalWidth > 0 ? undefined : new Error('Logo image is empty'));
    img.onerror = () => finish(new Error('Logo image could not load'));
    img.src = url;
  });
}
