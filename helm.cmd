@echo off
rem HELM — start the console and open it in the default browser
cd /d "%~dp0"
start "" http://127.0.0.1:7777
node server.js
