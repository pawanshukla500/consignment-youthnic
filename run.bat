@echo off
title Consignment Packing App - Dev Mode

echo ==========================================
echo  Consignment Packing App - Dev Mode
echo ==========================================
echo.

if not exist "%~dp0backend\node_modules" (
    echo [ERROR] Backend dependencies not found!
    echo Run: cd backend  then  npm install
    pause
    exit /b 1
)

if not exist "%~dp0frontend\node_modules" (
    echo [ERROR] Frontend dependencies not found!
    echo Run: cd frontend  then  npm install
    pause
    exit /b 1
)

echo Starting servers...
echo Backend:  http://localhost:5000  (API)
echo Frontend: http://localhost:5173  (OPEN THIS IN YOUR BROWSER)
echo.
echo Default login credentials are in backend\.env
echo.

start "Backend - Port 5000" /d "%~dp0backend" cmd /k "npm run dev"
timeout /t 3 /nobreak >nul
start "Frontend - Port 5173" /d "%~dp0frontend" cmd /k "npm run dev"

exit
