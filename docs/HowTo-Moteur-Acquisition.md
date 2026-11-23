# Moteur de supervision et d’acquisition

FUXA centralise les appareils configurés dans le gestionnaire des connexions. Plusieurs automates et serveurs OPC UA peuvent être configurés comme appareils distincts; les pilotes pris en charge incluent notamment OPC UA, Modbus TCP/RTU, Siemens S7 et MQTT.

## Connexions et fréquence

- Chaque appareil conserve sa connexion et son cycle d’acquisition. Le paramètre **Polling** de sa configuration règle individuellement la fréquence de lecture.
- Le moteur contrôle périodiquement les connexions et relance les appareils déconnectés. Les pilotes OPC UA possèdent également leur propre gestion de session et de reconnexion.
- Un polling désactivé ne signifie pas que la connexion est en panne : son état dépend alors de la connexion du pilote, et la qualité des données est indiquée comme inconnue.
- La vue **Connexions** regroupe les équipements configurés. La page **Diagnostic** d’un site montre leurs états, les dernières communications, les temps de réponse et les tags sans mise à jour.

## Horodatage et qualité

- Les valeurs gardent leur horodatage de réception. Pour OPC UA, les horodatages source et serveur sont aussi conservés lorsqu’ils sont fournis.
- OPC UA expose la qualité `good`, `uncertain` ou `bad`. Une mise à jour `bad` ne remplace pas la dernière valeur exploitable en mémoire; le diagnostic signale sa qualité et cette mesure n’est pas écrite dans l’historique DAQ.
- Pour les pilotes sans code de qualité natif, le diagnostic estime la qualité à partir de la fraîcheur de la dernière valeur (`good`, `stale` ou `unknown`).
- La mémoire des pilotes conserve la dernière valeur reçue pendant le fonctionnement. À la déconnexion, certains pilotes effacent les valeurs présentées à l’interface afin de ne pas les confondre avec des valeurs courantes.

## Éléments différés

- L’arbitrage des acquisitions par priorité est reporté; les cycles de lecture restent indépendants par appareil.
- La file d’attente d’écriture vers PostgreSQL est reportée jusqu’à la définition du schéma et de la cible d’écriture. Le PostgreSQL actuellement pris en charge comme appareil de lecture n’est pas un stockage DAQ.
