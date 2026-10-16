import { firebaseConfig } from './firebase-config.js';
import { validate, enforceLocks } from './ledger.js';

const LOCAL_PREFIX = 'hangout.local.event.v1.';
const LOCAL_CHANGE = 'hangout:local-event-change';
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const MAX_DATA_BYTES = 750_000;
const SDK_VERSION = '12.19.0';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function secret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function checkId(id) {
  if (typeof id !== 'string' || !SECRET_PATTERN.test(id)) {
    throw fail('invalid-link', 'This outing link is incomplete or invalid.');
  }
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function checkedData(data) {
  const keys = ['name', 'date', 'people', 'payments', 'settlements', 'closed'];
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !keys.includes(key))
      || keys.some(key => !(key in data))) {
    throw fail('invalid-data', 'The outing data is incomplete. Please reload and try again.');
  }
  let encoded;
  try {
    validate(data);
    encoded = JSON.stringify(data);
  } catch (error) {
    throw fail('invalid-data', error.message || 'This outing contains data that cannot be saved.');
  }
  if (new TextEncoder().encode(encoded).length > MAX_DATA_BYTES) {
    throw fail('outing-too-large', 'This outing has reached its storage limit. Start a new outing for more payments.');
  }
  return JSON.parse(encoded);
}

function checkLocks(previous, next) {
  try {
    enforceLocks(previous, next);
  } catch (error) {
    throw fail('locked-data', error.message || 'Reopen the related settlement before changing its expenses.');
  }
}

function publicRecord(id, record) {
  return { id, revision: record.revision, data: copy(record.data) };
}

function conflict() {
  return fail('conflict', 'This outing changed in another tab or device. Reload the latest version before saving again.');
}

function readLocal(id) {
  checkId(id);
  let raw;
  try {
    raw = localStorage.getItem(LOCAL_PREFIX + id);
  } catch {
    throw fail('storage-unavailable', 'Browser storage is unavailable. Enable storage for this site to use the preview.');
  }
  if (!raw) throw fail('not-found', 'This outing is not on this device. Local preview links work only in this browser.');
  try {
    const record = JSON.parse(raw);
    if (!record.data || !Number.isSafeInteger(record.revision) || !SECRET_PATTERN.test(record.token)) throw new Error();
    return record;
  } catch {
    throw fail('storage-corrupt', 'This local outing could not be read. Restore an exported backup if you have one.');
  }
}

function writeLocal(id, record) {
  try {
    localStorage.setItem(LOCAL_PREFIX + id, JSON.stringify(record));
  } catch {
    throw fail('storage-full', 'The browser could not save this outing. Free some browser storage and try again.');
  }
  window.dispatchEvent(new CustomEvent(LOCAL_CHANGE, { detail: { id } }));
}

function localStore() {
  return {
    mode: 'local',
    async create(data) {
      const value = checkedData(data);
      const id = secret();
      const token = secret();
      const record = { token, revision: 1, data: value };
      writeLocal(id, record);
      return { ...publicRecord(id, record), token };
    },
    async get(id) {
      return publicRecord(id, readLocal(id));
    },
    async canEdit(id, token) {
      if (typeof token !== 'string' || !SECRET_PATTERN.test(token)) return false;
      return readLocal(id).token === token;
    },
    async save(id, token, revision, data) {
      const value = checkedData(data);
      const commit = () => {
        const current = readLocal(id);
        if (!token || current.token !== token) throw fail('permission-denied', 'Use the private owner link to change this outing.');
        if (!Number.isSafeInteger(revision) || current.revision !== revision) throw conflict();
        checkLocks(current.data, value);
        const next = { token, revision: current.revision + 1, data: value };
        writeLocal(id, next);
        return publicRecord(id, next);
      };
      // Coordinate updates from local tabs when the browser supports Web Locks.
      return globalThis.navigator?.locks
        ? navigator.locks.request(LOCAL_PREFIX + id, commit)
        : commit();
    },
    subscribe(id, callback, onError = () => {}) {
      checkId(id);
      let active = true;
      const update = () => {
        if (!active) return;
        try { callback(publicRecord(id, readLocal(id))); }
        catch (error) { onError(error); }
      };
      const external = event => {
        if (event.key === LOCAL_PREFIX + id || event.key === null) update();
      };
      const internal = event => { if (event.detail.id === id) update(); };
      window.addEventListener('storage', external);
      window.addEventListener(LOCAL_CHANGE, internal);
      queueMicrotask(update);
      return () => {
        active = false;
        window.removeEventListener('storage', external);
        window.removeEventListener(LOCAL_CHANGE, internal);
      };
    }
  };
}

async function cloudStore(config) {
  const [{ initializeApp, getApps }, { getAuth, signInAnonymously }, firestore] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`)
  ]);
  const app = getApps().find(item => item.name === 'hangout') || initializeApp(config, 'hangout');
  const auth = getAuth(app);
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  const uid = auth.currentUser.uid;
  const { getFirestore, doc, getDocFromServer, writeBatch, setDoc, runTransaction, onSnapshot, serverTimestamp } = firestore;
  const db = getFirestore(app);
  const eventRef = id => { checkId(id); return doc(db, 'events', id); };
  const knownGrants = new Set();

  async function canEdit(id, token) {
    checkId(id);
    if (typeof token !== 'string' || !SECRET_PATTERN.test(token)) return false;
    const cacheKey = `${id}:${token}`;
    if (knownGrants.has(cacheKey)) return true;
    const linkSnapshot = await getDocFromServer(doc(db, 'editLinks', token));
    if (!linkSnapshot.exists() || linkSnapshot.data().eventId !== id) return false;
    const link = linkSnapshot.data();
    if (link.ownerUid !== uid) {
      const grantRef = doc(db, 'events', id, 'editors', uid);
      const grant = await getDocFromServer(grantRef);
      if (!grant.exists()) {
        try {
          await setDoc(grantRef, { token, createdAt: serverTimestamp() });
        } catch (error) {
          // Another tab with this same anonymous identity may have claimed it first.
          const concurrentGrant = await getDocFromServer(grantRef);
          if (!concurrentGrant.exists()) throw error;
        }
      }
    }
    knownGrants.add(cacheKey);
    return true;
  }

  return {
    mode: 'cloud',
    async create(data) {
      const value = checkedData(data);
      const id = secret();
      const token = secret();
      const batch = writeBatch(db);
      batch.set(eventRef(id), {
        ownerUid: uid, revision: 1, data: value,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      // The private key is a document ID in a separate, non-listable collection.
      // Neither it nor a hash of it appears in the document viewers can read.
      batch.set(doc(db, 'editLinks', token), { eventId: id, ownerUid: uid, createdAt: serverTimestamp() });
      await batch.commit();
      knownGrants.add(`${id}:${token}`);
      return { id, token, revision: 1, data: copy(value) };
    },
    async get(id) {
      const snapshot = await getDocFromServer(eventRef(id));
      if (!snapshot.exists()) throw fail('not-found', 'This outing could not be found. Check the link and try again.');
      return publicRecord(id, snapshot.data());
    },
    canEdit,
    async save(id, token, revision, data) {
      const value = checkedData(data);
      if (!(await canEdit(id, token))) throw fail('permission-denied', 'Use the private owner link to change this outing.');
      return runTransaction(db, async transaction => {
        const ref = eventRef(id);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw fail('not-found', 'This outing could not be found.');
        const current = snapshot.data();
        if (!Number.isSafeInteger(revision) || current.revision !== revision) throw conflict();
        checkLocks(current.data, value);
        transaction.update(ref, { revision: revision + 1, data: value, updatedAt: serverTimestamp() });
        return { id, revision: revision + 1, data: copy(value) };
      });
    },
    subscribe(id, callback, onError = () => {}) {
      return onSnapshot(eventRef(id), { includeMetadataChanges: true }, snapshot => {
        // A saved update is shown only once the server has acknowledged it.
        if (snapshot.metadata.hasPendingWrites) return;
        if (!snapshot.exists()) {
          onError(fail('not-found', 'This outing could not be found.'));
          return;
        }
        callback(publicRecord(id, snapshot.data()));
      }, onError);
    }
  };
}

/** No configuration: explicit local preview. Configured Firebase errors never fall back to local storage. */
export async function initStore() {
  if (firebaseConfig === null) return localStore();
  if (!firebaseConfig || !['apiKey', 'authDomain', 'projectId', 'appId'].every(key => typeof firebaseConfig[key] === 'string' && firebaseConfig[key].trim())) {
    throw fail('firebase-config', 'Firebase configuration is incomplete. Add the full web app configuration in firebase-config.js.');
  }
  try {
    return await cloudStore(firebaseConfig);
  } catch (error) {
    throw fail(error.code || 'firebase-unavailable', `Could not connect to the shared database. Check your internet connection and Firebase setup. ${error.message || ''}`);
  }
}
