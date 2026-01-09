import React, { useState, useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import FileManager from './components/FileManager';
import './App.css';

function App() {
  const { instance, accounts } = useMsal();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    if (accounts.length > 0) {
      setIsAuthenticated(true);
      setUser(accounts[0]);
    }
  }, [accounts]);

  const handleLogin = async () => {
    try {
      await instance.loginPopup();
    } catch (error) {
      console.error('Login error:', error);
    }
  };

  const handleLogout = () => {
    instance.logoutPopup();
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Blob Storage Gateway</h1>
        {isAuthenticated ? (
          <div className="auth-info">
            <span>Welcome, {user?.name || user?.username}</span>
            <button onClick={handleLogout} className="btn btn-logout">
              Logout
            </button>
          </div>
        ) : (
          <button onClick={handleLogin} className="btn btn-login">
            Login with Azure AD
          </button>
        )}
      </header>

      {isAuthenticated ? (
        <main className="App-main">
          <FileManager />
        </main>
      ) : (
        <main className="App-main">
          <p>Please log in to access files.</p>
        </main>
      )}
    </div>
  );
}

export default App;
