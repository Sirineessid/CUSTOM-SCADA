# Maintenance industrielle des sites

Chaque site dispose d’une page **Maintenance** dans la barre de navigation, à côté de ses pages Courbes, Configuration, Alarmes et Diagnostic. Les données sont isolées par site et enregistrées dans son dossier `_appdata`; elles sont incluses dans les sauvegardes du site.

## Utilisation

- **Équipements** : créez la fiche, puis renseignez les informations techniques et associez au besoin des tags du site pour l’état marche/arrêt, le défaut et le compteur horaire. Le compteur associé doit représenter un total en heures. Sans compteur, la valeur cumulée initiale/saisie de la fiche est affichée.
- **Documents PDF** : depuis la fiche équipement, ajoutez des PDF (15 Mo maximum), ouvrez-les ou supprimez-les.
- **Interventions / pannes** : consignez la date, le technicien, le statut, le coût et la durée. Une pièce sélectionnée dans le formulaire est déduite du stock; la suppression de l’intervention la restitue.
- **Maintenance préventive** : définissez une périodicité en jours et/ou heures compteur. Les éléments en retard et ceux à prévoir (dans les 30 jours ou à moins de 10 % de l’intervalle horaire) sont signalés dans la page. « Effectuée » réinitialise l’échéance à partir de la date et du compteur actuels.
- **Pièces de rechange** : suivez les quantités, emplacements et seuils de réapprovisionnement.

La disponibilité est calculée sur les valeurs historisées du tag de marche durant les 30 derniers jours. Le pourcentage de couverture des données est affiché avec cette estimation; la couverture partielle ne doit pas être interprétée comme une mesure complète de disponibilité. Activez l’enregistrement DAQ du tag de marche pour obtenir des mesures utiles. Les données d’historique non disponibles produisent une disponibilité inconnue plutôt qu’un résultat inventé.

## API du site

Les services sont sous `/api/v1/sites/{site_id}/maintenance` et suivent le format API v1 `{ data, meta }`. L’authentification du site s’applique lorsque la sécurité FUXA est activée.

- `GET /maintenance` : équipements, interventions/pannes, plans préventifs, pièces et tags disponibles.
- `GET /maintenance/metrics?from=&to=` : heures compteur, état/défaut, disponibilité observée et échéances (période maximale : 366 jours).
- `POST`, `PUT` et `DELETE` sur `assets`, `work-orders`, `schedules` et `parts` : gestion des fiches et enregistrements.
- `POST /assets/{asset_id}/documents?name=fiche.pdf` avec un corps `application/pdf`, `GET /documents/{document_id}` et `DELETE /documents/{document_id}` : gestion des documents.

Les suppressions d’équipements ayant un historique ou un plan, et celles de pièces référencées par des interventions, sont refusées afin de préserver l’historique.
