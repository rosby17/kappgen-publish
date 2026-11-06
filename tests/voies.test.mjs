import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Envois en parallèle (Roosevelt, 06/11) : plusieurs vidéos YouTube en même temps, Facebook et les autres réseaux sans attendre YouTube.
const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const panneau = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const commun = bg.slice(bg.indexOf('const VOIES_YOUTUBE'), bg.indexOf('// Onglets de travail de toutes les voies'));
const outils = new Function(`${commun}; return { IDS_VOIES, VOIE_PRINCIPALE, VOIE_RESEAUX, enSerie, revendiquer, liberer, priseParUneAutre, clePrise, prises };`)();
const voieDe = new Function(`${bg.slice(bg.indexOf('const TYPES_YOUTUBE'), bg.indexOf('async function voieYoutubeLibre'))}; return { TYPES_YOUTUBE, TYPES_RESEAUX, TYPES_DE_LA_VOIE };`)();

test('trois voies YouTube et trois voies pour les autres réseaux', () => {
  assert.deepEqual(outils.IDS_VOIES, ['yt1', 'yt2', 'yt3', 'rs', 'rs2', 'rs3']);
  assert.equal(outils.VOIE_PRINCIPALE, 'yt1');
  assert.equal(outils.VOIE_RESEAUX, 'rs');
});

test('les écritures dans la mémoire commune passent une à une, même quand l’une échoue', async () => {
  const trace = [];
  const lente = (nom, ms, echec = false) => outils.enSerie(async () => {
    trace.push(`début ${nom}`);
    await new Promise((r) => setTimeout(r, ms));
    trace.push(`fin ${nom}`);
    if (echec) throw new Error(nom);
    return nom;
  });
  const r = await Promise.allSettled([lente('a', 20, true), lente('b', 1), lente('c', 5)]);
  assert.deepEqual(trace, ['début a', 'fin a', 'début b', 'fin b', 'début c', 'fin c']);
  assert.equal(r[0].status, 'rejected');
  assert.equal(r[1].value, 'b');
});

test('une vidéo prise par une voie n’est jamais envoyée par une autre', () => {
  const cle = outils.clePrise('folder', 'BALLON-VIRAL/contenus/038/06-rendu/bv-38.mp4');
  assert.equal(outils.revendiquer(cle, 'yt1', 'ballon-viral'), true);
  assert.equal(outils.revendiquer(cle, 'yt1'), true, 'la même voie la reprend (publish après le choix du passage)');
  assert.equal(outils.revendiquer(cle, 'yt2'), false);
  assert.equal(outils.priseParUneAutre(cle, 'yt2'), true);
  assert.equal(outils.prises.get(cle).chaine, 'ballon-viral', 'la chaîne reste connue (une vidéo programmée par marque à la fois)');
  outils.liberer(cle, 'yt2');
  assert.equal(outils.priseParUneAutre(cle, 'yt2'), true, 'une autre voie ne peut pas la libérer');
  outils.liberer(cle, 'yt1');
  assert.equal(outils.revendiquer(cle, 'yt2'), true);
});

test('les commandes du panneau vont dans la bonne voie', () => {
  for (const t of ['publish', 'republish', 'resendYoutube', 'shortYoutube', 'update']) assert.ok(voieDe.TYPES_YOUTUBE.has(t), t);
  for (const t of ['facebook', 'postNow', 'shareGroups', 'instagram', 'tiktok', 'x', 'linkedin', 'snapchat', 'pinterestPost']) assert.ok(voieDe.TYPES_RESEAUX.has(t), t);
  for (const t of ['cancelJob', 'unblockJob', 'clearJob']) assert.ok(voieDe.TYPES_DE_LA_VOIE.has(t), t);
  assert.match(bg, /const handler = handlers\[message\.type\];/);
});

test('chaque voie a sa mémoire, sa fenêtre et ses propres tâches', () => {
  const modele = bg.slice(bg.indexOf('function creerVoie('), bg.indexOf('// ---- fin du modèle de voie'));
  assert.match(modele, /const CLE_JOB = PRINCIPALE \? 'job' : `job:\$\{VOIE\}`;/);
  assert.match(modele, /async function createWorkTab\(url\) \{\n  const tab = await ongletDansMaFenetre\(url\);/);
  assert.match(modele, /if \(ROLE === 'reseaux'\) \{ if \(VOIE === VOIE_RESEAUX\) await passeReseaux\(/, 'Facebook et les autres réseaux ont leur passage');
  assert.match(modele, /if \(!PRINCIPALE\) return;\n  let stale = null;/, 'les mises à jour des vidéos en ligne restent dans la voie principale');
  assert.match(modele, /if \(!PRINCIPALE\) return null;/, 'seule la voie principale reprend un onglet de la personne');
  assert.doesNotMatch(modele, /storage\.session\.get\('job'\)|storage\.local\.get\('pending'\)/);
});

test('le panneau montre une carte par envoi et annule dans la bonne voie', () => {
  assert.match(panneau, /cle === 'job' \? 'yt1' : cle\.startsWith\('job:'\)/);
  assert.match(panneau, /send\(\{ type: 'cancelJob', voie \}\)/);
  assert.doesNotMatch(panneau, /go\.disabled = jobRunning/);
});

test('un Short ou une mise à jour attend une fenêtre libre au lieu d’échouer quand les 3 voies YouTube travaillent', () => {
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /voieYoutubeLibre\(type !== 'publish' && type !== 'resumeInterrupted'\)/);
  assert.match(bg, /attenteDeVoie\.push\(\{ message, sender \}\)/);
  assert.match(bg, /return \{ queued: true, position: attenteDeVoie\.length, attendFenetre: true \}/);
});

test('l’étape Visibilité ne reclique jamais la même bulle (bandeau Short « Ignorer » resté affiché)', () => {
  const studio = readFileSync(new URL('../extension/studio.js', import.meta.url), 'utf8');
  assert.match(studio, /!bullesVues\.has\(b\)/);
  assert.match(studio, /bullesVues\.add\(bubble\)/);
});

test('le questionnaire des Shorts « Aucun contenu non adapté aux annonceurs » est reconnu', () => {
  const studio = readFileSync(new URL('../extension/studio.js', import.meta.url), 'utf8');
  const ligne = studio.split('\n').find((l) => l.includes('const NONE_TEXT ='));
  const NONE_TEXT = new Function(`${ligne}; return NONE_TEXT;`)();
  assert.ok(NONE_TEXT.test('Aucun contenu non adapté aux annonceurs'));
  assert.ok(NONE_TEXT.test('Aucun des éléments ci-dessus'));
  assert.ok(NONE_TEXT.test('None of the above'));
  assert.ok(!NONE_TEXT.test('Contenu relatif aux armes à feu'));
});

test('« Envoyer l’évaluation » grisé (déjà envoyée) n’empêche plus de passer à « Suivant »', () => {
  const studio = readFileSync(new URL('../extension/studio.js', import.meta.url), 'utf8');
  assert.match(studio, /const findSubmit = \(\) => \[[^\n]*\]\.find\(actif\) \|\| null;/);
  assert.match(studio, /if \(!findSubmit\(\) && nextEnabled\(\)\) return false;/);
});

test('les posts attendent la voie Réseaux et la carte « En cours » a un bouton « Voir »', () => {
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(bg, /attenteReseaux\.push\(\{ message, sender \}\)/);
  assert.match(bg, /async function montrerVoie\(voie\)/);
  assert.match(panel, /type: 'montrerVoie', voie/);
  assert.match(panel, /data\.attendReseaux/);
});

test('Facebook rechargé pendant « sendPost » : vérifie la Page au lieu de noter un échec', () => {
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const bloc = bg.slice(bg.indexOf('async function postStep'), bg.indexOf('const STEP_RELOAD_TRIES'));
  assert.match(bloc, /a été rechargée pendant l’étape/);
  assert.match(bloc, /'verifyPublication'/);
});

test('3 fenêtres Réseaux pour les clics, le rattrapage automatique reste dans la seule voie « rs »', () => {
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /const VOIES_RESEAUX = 3;/);
  assert.match(bg, /if \(ROLE === 'reseaux'\) \{ if \(VOIE === VOIE_RESEAUX\) await passeReseaux/);
  assert.match(bg, /if \(await reseauDejaEnCours\(message\.path\)\) throw/);
  assert.match(bg, /async function voieReseauxLibre\(\)/);
});

test('un post resté « en cours » sans publication vivante passe « à vérifier » après un démarrage', () => {
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const bloc = bg.slice(bg.indexOf('async function postsInterrompus'), bg.indexOf('async function heartbeat'));
  assert.match(bloc, /p\.statut !== 'en_cours' \|\| vivants\.has\(p\.path\)/);
  assert.match(bloc, /statut: 'a_verifier'/, 'jamais republié tout seul');
  assert.match(bg, /postsInterrompus\(\)\.catch/);
});

test('un post « en cours » sans publication vivante est dit interrompu et peut être noté publié, archivé ou supprimé', () => {
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(panel, /const coupe = post\.statut === 'en_cours' && !\[\.\.\.jobs\.values\(\)\]\.some/);
  assert.match(panel, /coupe \? \[editEntry\(item, post\), alreadyDone\([^\n]*archiveEntry\(item, post\), eraseEntry\(item, post\)\]/);
});
