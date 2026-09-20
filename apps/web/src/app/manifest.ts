import type { MetadataRoute } from 'next';

// Icons are the approved exports in public/brand/deployz (see
// apps/web/brand/deployz/README.md). The colors match the light --background
// token, which is the surface every page opens on.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Deployz',
    short_name: 'Deployz',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/brand/deployz/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/deployz/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/brand/deployz/maskable-icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/brand/deployz/maskable-icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
