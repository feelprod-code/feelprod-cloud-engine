#!/bin/bash
# Script de synchronisation massive des rendus finaux vers Cloudflare R2
# Utilise AWS CLI configuré avec les credentials R2 de FeelProd.

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <dossier_source_local> <nom_du_bucket_r2>"
    echo "Exemple: $0 \"/Volumes/1 TERA NOIR/1-VISAGE D'ATMA/0-PRODUCTION/Synchroniques\" feelprod-damoiseaux"
    exit 1
fi

SOURCE_DIR="$1"
BUCKET_NAME="$2"

# L'endpoint de l'API S3 de Cloudflare pour le compte FeelProd
ENDPOINT_URL="https://1ccc317bc1e8d1a6e5675c7b94556d5f.r2.cloudflarestorage.com"

echo "=========================================================="
echo "🚀 Début de l'Upload vers Cloudflare R2"
echo "Source : $SOURCE_DIR"
echo "Bucket : s3://$BUCKET_NAME"
echo "=========================================================="

# On s'assure que aws-cli est bien installé
if ! command -v aws &> /dev/null; then
    echo "Erreur : aws-cli n'est pas installé. Veuillez l'installer."
    exit 1
fi

# Lancement de la synchronisation
aws s3 sync "$SOURCE_DIR" "s3://$BUCKET_NAME/" \
    --endpoint-url "$ENDPOINT_URL"

echo "=========================================================="
echo "✅ Synchronisation R2 terminée !"
echo "=========================================================="
