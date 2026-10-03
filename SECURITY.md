# Sécurité

## Signaler une vulnérabilité

Ne publie pas de preuve de concept contenant un chemin local, un jeton, un cookie ou une donnée personnelle dans une issue publique. Signale le problème via le contact privé disponible sur [app.kappgen.com](https://app.kappgen.com) avec :

- la version de KappGen Publish et de Chrome ;
- le scénario de reproduction minimal ;
- l’impact observé ;
- des captures expurgées de toute donnée sensible.

Une réception doit être confirmée dès que possible. Les détails peuvent être publiés après mise à disposition d’une correction.

## Périmètre technique

- Extension Chrome Manifest V3, Chrome 116 minimum.
- Les fichiers locaux ne sont remis aux pages sociales qu’avec un jeton à usage unique, lié à l’onglet et expirant après deux minutes.
- La configuration distante est composée de données déclaratives validées ; aucun script distant n’est exécuté.
- Pour une vidéo issue de l’application locale, l’attachement `debugger` est refusé hors de `localhost`/`127.0.0.1`, limité à l’onglet YouTube Studio de la publication et systématiquement détaché dans un bloc de nettoyage.
- Un fichier de configuration ou de suivi invalide bloque la publication au lieu de déclencher des valeurs implicites susceptibles de produire un doublon.
- Les archives de release sont accompagnées d’une empreinte SHA-256, vérifiée par les installateurs guidés.
- Le contrôle d’accès KappGen est obligatoire avant toute publication.

Avant de distribuer une modification, exécute `npm run check` et n’utilise que `publier-version.sh` depuis un dépôt propre et à jour.
