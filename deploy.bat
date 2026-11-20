@echo off
setlocal
title Push recruiting website to GitHub
cd /d "%~dp0"
set REPO=https://github.com/adamdispatching-stack/recruiting.git

echo.
echo  Pushing this folder to %REPO%
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo  Git is not installed on this computer.
  echo  The download page will open. Install Git with the default options, then double-click deploy.bat again.
  start "" https://git-scm.com/download/win
  pause
  exit /b 1
)

if not exist ".git" (
  git init >nul
  git checkout -B main >nul 2>nul
)
git checkout -B main >nul 2>nul

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin %REPO%
) else (
  git remote set-url origin %REPO%
)

rem A name for the commit, only for this folder, if Git has none yet
git config user.name >nul 2>nul || git config user.name "adamdispatching-stack"
git config user.email >nul 2>nul || git config user.email "adamdispatching-stack@users.noreply.github.com"

git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Update recruiting website" >nul
  echo  Saved the changes in a new commit.
) else (
  echo  No new changes to save.
)

rem If GitHub already has commits (for example files uploaded on the website), put ours on top of them
git ls-remote --exit-code --heads origin main >nul 2>nul
if not errorlevel 1 (
  git pull --rebase --allow-unrelated-histories origin main
  if errorlevel 1 (
    echo.
    echo  Your files and the ones on GitHub conflict. Nothing was pushed.
    echo  Send Claude a screenshot of this window.
    pause
    exit /b 1
  )
)

echo.
echo  Pushing. If a GitHub sign-in window opens, sign in as adamdispatching-stack.
echo.
git push -u origin main
if errorlevel 1 (
  echo.
  echo  The push failed. Make sure you are signed in to GitHub as adamdispatching-stack,
  echo  then double-click deploy.bat again. If it fails again, send Claude a screenshot.
  pause
  exit /b 1
)

echo.
echo  Done. The code is on GitHub:
echo  https://github.com/adamdispatching-stack/recruiting
echo  If Railway is connected to this repo, it starts deploying in a few seconds.
echo.
start "" https://github.com/adamdispatching-stack/recruiting
pause
