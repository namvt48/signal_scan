import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// Firebase web config from env vars (VITE_FIREBASE_*) — these are public client
// identifiers by design: they ship in the bundle. Authorization lives server-side.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
