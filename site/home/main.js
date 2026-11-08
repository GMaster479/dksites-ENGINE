// dksites.com homepage.
// GA4: create a GA4 property for dksites.com and paste its Measurement ID here (G-XXXXXXX).
// Nothing loads until it's set.
const GA4_ID = '';

if (GA4_ID) {
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA4_ID);
  // Count clicks into the builder as the conversion that matters.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="https://app.dksites.com"]');
    if (a) window.gtag('event', 'start_builder', { link_text: a.textContent.trim() });
  });
}

const yr = document.getElementById('yr');
if (yr) yr.textContent = String(new Date().getFullYear());
