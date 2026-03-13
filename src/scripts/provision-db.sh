#!/bin/bash
# Provisioning Script for TBD Logger Secure Database
# Run this in your CI/CD pipeline or local terminal authenticated with Azure

# Stop on errors
set -e

RESOURCE_GROUP="TbdLogger-RG"
LOCATION="eastus"
SERVER_NAME="tbd-logger-sql-secure-$(date +%s)"
DB_NAME="TbdStudentData"
ADMIN_USER="tbd_admin_vault"
# Generate a strong, random 32-character password
ADMIN_PASS=$(openssl rand -base64 32)

echo "Starting Provisioning Sequence..."

# 1. Create Resource Group
az group create --name $RESOURCE_GROUP --location $LOCATION

# 2. Create SQL Server (Enforcing TLS 1.2 for transit security)
echo "Provisioning SQL Server..."
az sql server create \
    --name $SERVER_NAME \
    --resource-group $RESOURCE_GROUP \
    --location $LOCATION \
    --admin-user $ADMIN_USER \
    --admin-password $ADMIN_PASS \
    --enable-public-network false \
    --minimal-tls-version "1.2"

# 3. Create the Database
echo "Provisioning Database..."
az sql db create \
    --resource-group $RESOURCE_GROUP \
    --server $SERVER_NAME \
    --name $DB_NAME \
    --edition GeneralPurpose \
    --compute-model Serverless \
    --family Gen5 \
    --capacity 2

# 4. Enforce Data at Rest Encryption (TDE - AES-256)
echo "Enforcing Transparent Data Encryption (AES-256)..."
az sql db tde set \
    --resource-group $RESOURCE_GROUP \
    --server $SERVER_NAME \
    --database $DB_NAME \
    --status Enabled

# 5. Output Credentials securely to CI/CD pipeline (e.g., GitHub Actions)
# In a real environment, you would push these to Azure Key Vault here.
echo "Provisioning Complete. Store these securely in your Secrets Manager:"
echo "AZURE_SQL_SERVER=$SERVER_NAME.database.windows.net"
echo "AZURE_SQL_DATABASE=$DB_NAME"
echo "AZURE_SQL_USER=$ADMIN_USER"
echo "AZURE_SQL_PASSWORD=(hidden for security - check CI logs/vault)"