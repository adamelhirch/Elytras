# Tester comme sur un VPS — VMs locales (Multipass)

Multipass crée de **vraies VMs Ubuntu** sur ton Mac, isolées, avec leur propre IP — la mise en
situation la plus proche d'un VPS, **gratuite**. Tu peux en lancer plusieurs pour simuler
plusieurs clients.

## 1. Installer Multipass (une fois)

```bash
brew install --cask multipass
```

## 2. Créer une VM « client » prête à l'emploi

```bash
cd deploy/vm
./provision-multipass.sh elytras-client1
```

Le script crée la VM, installe Docker, et y copie Elytras (sans tes secrets ni environnements Python).

## 3. Déployer dans la VM

```bash
multipass shell elytras-client1
cd ~/elytras/deploy && ./install.sh
```

L'onboarding se lance (secteur, IA, domaine, modules), puis tout démarre en conteneurs.
Depuis ton Mac, ouvre **http://<IP de la VM>** (l'IP est affichée à la fin du provisioning,
ou via `multipass list`).

> Astuce : pour tester le **mode Codex** (login OAuth en loopback) depuis ton Mac vers la VM,
> ouvre un tunnel : `multipass exec elytras-client1 -- ...` ou un `ssh -L` vers l'IP de la VM.

## 4. Plusieurs « clients »

```bash
./provision-multipass.sh elytras-client2
./provision-multipass.sh garage-martin
multipass list
```

## Gérer les VMs

```bash
multipass list                       # voir les VMs et leurs IP
multipass stop  elytras-client1      # arrêter
multipass start elytras-client1      # redémarrer
multipass delete elytras-client1 --purge   # supprimer
```
