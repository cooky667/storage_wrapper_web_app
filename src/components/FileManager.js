import React, { useState, useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../msalConfig';
import axios from 'axios';
import './FileManager.css';

const FileManager = () => {
  const { instance, accounts } = useMsal();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [userRoles, setUserRoles] = useState({
    isReader: false,
    isUploader: false,
    isAdmin: false,
  });

  const API_URL = process.env.REACT_APP_API_URL;

  // Fetch access token
  const getAccessToken = async () => {
    try {
      const response = await instance.acquireTokenSilent({
        scopes: loginRequest.scopes,
        account: accounts[0],
      });
      return response.accessToken;
    } catch (error) {
      console.error('Error acquiring token:', error);
      throw error;
    }
  };

  // Decode token to get user roles
  const decodeToken = (token) => {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  };

  // Fetch files on component mount and set roles
  useEffect(() => {
    const initializeComponent = async () => {
      try {
        const token = await getAccessToken();
        const decoded = decodeToken(token);
        const groups = decoded['groups'] || [];

        console.log('Token decoded. Groups:', groups);
        console.log('Reader Group ID:', process.env.REACT_APP_READER_GROUP_ID);
        console.log('Is in Reader group:', groups.includes(process.env.REACT_APP_READER_GROUP_ID));

        // Check explicit group membership
        const isReader = groups.includes(process.env.REACT_APP_READER_GROUP_ID);
        const isUploader = groups.includes(process.env.REACT_APP_UPLOADER_GROUP_ID);
        const isAdmin = groups.includes(process.env.REACT_APP_ADMIN_GROUP_ID);

        console.log('User roles:', { isReader, isUploader, isAdmin });

        setUserRoles({
          isReader,
          isUploader,
          isAdmin,
        });

        // Only fetch files if user is in at least the reader group
        if (isReader || isUploader || isAdmin) {
          fetchFiles(token);
        } else {
          setError('You do not have permission to access files.');
        }
      } catch (error) {
        console.error('Initialization error:', error);
        setError('Failed to initialize. Please log in again.');
      }
    };

    initializeComponent();
  }, [accounts, instance]);

  const fetchFiles = async (token) => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/files`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setFiles(response.data.files || []);
    } catch (error) {
      console.error('Error fetching files:', error);
      setError('Failed to fetch files.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setError('Please select a file.');
      return;
    }

    try {
      setLoading(true);
      const token = await getAccessToken();

      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = reader.result.split(',')[1];
        try {
          await axios.post(
            `${API_URL}/api/files`,
            {
              filename: selectedFile.name,
              data: base64Data,
            },
            { headers: { Authorization: `Bearer ${token}` } }
          );
          setSelectedFile(null);
          fetchFiles(token);
          setError(null);
        } catch (uploadError) {
          console.error('Upload error:', uploadError);
          setError('Failed to upload file.');
        } finally {
          setLoading(false);
        }
      };
      reader.readAsDataURL(selectedFile);
    } catch (error) {
      console.error('Error preparing upload:', error);
      setError('Failed to prepare upload.');
      setLoading(false);
    }
  };

  const handleDownload = async (filename) => {
    try {
      setLoading(true);
      const token = await getAccessToken();
      const response = await axios.get(`${API_URL}/api/files/${filename}`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      setError(null);
    } catch (error) {
      console.error('Download error:', error);
      setError('Failed to download file.');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (filename) => {
    if (!window.confirm(`Delete ${filename}?`)) return;

    try {
      setLoading(true);
      const token = await getAccessToken();
      await axios.delete(`${API_URL}/api/files/${filename}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchFiles(token);
      setError(null);
    } catch (error) {
      console.error('Delete error:', error);
      setError('Failed to delete file.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="file-manager">
      <div className="roles-info">
        <h3>Your Access:</h3>
        <ul>
          <li>{userRoles.isReader ? '✓' : '✗'} Reader {userRoles.isReader && '(You have access)'}</li>
          <li>{userRoles.isUploader ? '✓' : '✗'} Uploader</li>
          <li>{userRoles.isAdmin ? '✓' : '✗'} Admin</li>
        </ul>
      </div>

      {error && <div className="error-message">{error}</div>}

      {userRoles.isUploader && (
        <div className="upload-section">
          <h3>Upload File</h3>
          <input
            type="file"
            onChange={(e) => setSelectedFile(e.target.files[0])}
            disabled={loading}
          />
          <button onClick={handleUpload} disabled={loading || !selectedFile}>
            {loading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      )}

      <div className="files-section">
        <h3>Files</h3>
        {loading && <p>Loading...</p>}
        {files.length === 0 && !loading && <p>No files yet.</p>}
        <ul className="file-list">
          {files.map((file) => (
            <li key={file.name} className="file-item">
              <span>{file.name}</span>
              <span className="file-size">({(file.size / 1024).toFixed(2)} KB)</span>
              <div className="file-actions">
                <button onClick={() => handleDownload(file.name)} disabled={loading}>
                  Download
                </button>
                {userRoles.isUploader && (
                  <button onClick={() => handleDelete(file.name)} disabled={loading}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default FileManager;
