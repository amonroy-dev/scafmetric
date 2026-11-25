# Retro landing page (archived 2026-11-25)

The landing page as it was before the dark "operations wall" redesign: the
pixel-font hero with the beam lab, the starfield and the section library.

To bring it back, copy index.html, landing.css and landing.js from this folder
over the ones at the root of the repo. It uses public/fonts/press-start-2p.woff2
and public/fonts/vt323.woff2, which are still in the repo.

Its five screenshots of the old beam workspace are in screenshots/ here. They
were in public/marketing/screenshots/, which is where the page looks for them,
until the new landing page got pictures of the redesigned product (taken by
scripts/marketing-shots.mjs). Copy them back there too.

This folder is not copied into dist/ by scripts/build.mjs, so it is not served.
