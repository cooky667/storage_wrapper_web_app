import React, { useState, useEffect, useCallback } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../msalConfig';
import axios from 'axios';
import './FileManager.css';

const FileManager = () => {
  const { instance, accounts } = useMsal();
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameName, setRenameName] = useState('');
  const [userRoles, setUserRoles] = useState({
    isReader: false,
    isUploader: false,
    isAdmin: false,
  });

  const API_URL = process.env.REACT_APP_API_URL;

  // Fetch access token
  const getAccessToken = useCallback(async () => {
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
  }, [instance, accounts]);

  // Fetch files and folders
  const fetchFiles = useCallback(async (token, folderPath = '') => {
    setLoading(true);
    setError(null);
    try {
      const query = folderPath && folderPath !== '/' ? `?folder=${encodeURIComponent(folderPath)}` : '';
      const response = await axios.get(`${API_URL}/api/files${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setCurrentPath(response.data.currentPath || '/');
      setFiles(response.data.files || []);
      setFolders(response.data.folders || []);
    } catch (error) {
      console.error('Error fetching files:', error);
      setError('Failed to fetch files.');
    } finally {
      setLoading(false);
    }
  }, [API_URL]);

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
  }, [accounts, instance, fetchFiles, getAccessToken]);

  // Chunked upload for large files (>100MB)
  const handleChunkedUpload = async (file, token) => {
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB chunks (good balance: not too large, not too many)
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    
    console.log(`Uploading ${file.name} in ${totalChunks} chunks`);
    setUploadProgress({ current: 0, total: totalChunks, filename: file.name });

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const formData = new FormData();
      formData.append('file', chunk);

      const params = new URLSearchParams({
        filename: file.name,
        chunkIndex,
        totalChunks,
      });

      console.log(`Uploading chunk ${chunkIndex + 1}/${totalChunks}`);

      await axios.post(
        `${API_URL}/api/files/chunked?${params.toString()}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      setUploadProgress({ current: chunkIndex + 1, total: totalChunks, filename: file.name });
    }

    // Commit all chunks
    console.log('Committing chunks...');
    setUploadProgress({ current: totalChunks, total: totalChunks, filename: file.name, committing: true });
    await axios.post(
      `${API_URL}/api/files/chunked/commit`,
      {
        filename: file.name,
        totalChunks,
        contentType: file.type || 'application/octet-stream',
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Upload completed');
    setUploadProgress(null);
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setError('Please select a file.');
      return;
    }

    try {
      setLoading(true);
      const token = await getAccessToken();

      // Use chunked upload for files > 100MB (streaming per chunk, no memory buffering)
      const USE_CHUNKED_THRESHOLD = 100 * 1024 * 1024; // 100 MB
      if (selectedFile.size > USE_CHUNKED_THRESHOLD) {
        await handleChunkedUpload(selectedFile, token);
        setSelectedFile(null);
        setError(null);
        fetchFiles(token);
        return;
      }

      // Standard upload for smaller files
      const formData = new FormData();
      formData.append('file', selectedFile);

      const response = await axios.post(
        `${API_URL}/api/files`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            // Do NOT set Content-Type for FormData; browser adds boundary automatically
          },
        }
      );

      const startedFilename = response?.data?.filename || selectedFile.name;
      setSelectedFile(null);
      setError(null);

      // Poll for existence until blob appears, then refresh list
      const pollIntervalMs = 3000;
      const maxAttempts = 100; // ~5 minutes
      let attempts = 0;
      const intervalId = setInterval(async () => {
        attempts += 1;
        try {
          const existsResp = await axios.get(`${API_URL}/api/files/exists/${encodeURIComponent(startedFilename)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (existsResp?.data?.exists) {
            clearInterval(intervalId);
            fetchFiles(token);
          } else if (attempts >= maxAttempts) {
            clearInterval(intervalId);
            console.warn('Polling timed out for', startedFilename);
          }
        } catch (e) {
          console.warn('Exists check failed:', e?.message || e);
          if (attempts >= maxAttempts) {
            clearInterval(intervalId);
          }
        }
      }, pollIntervalMs);
    } catch (error) {
      console.error('Upload error:', error);
      setError('Failed to upload file.');
    } finally {
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
      fetchFiles(token, currentPath === '/' ? '' : currentPath);
      setError(null);
    } catch (error) {
      console.error('Delete error:', error);
      setError('Failed to delete file.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      setError('Folder name cannot be empty.');
      return;
    }

    try {
      setLoading(true);
      const token = await getAccessToken();
      const folderPath = currentPath === '/' 
        ? newFolderName 
        : currentPath + '/' + newFolderName;
      
      await axios.post(
        `${API_URL}/api/files/folders/create`,
        { folderPath },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      setNewFolderName('');
      setShowCreateFolder(false);
      setError(null);
      
      // Show success message about virtual folders
      alert(`Folder "${newFolderName}" created! Note: Folders are virtual in Azure Blob Storage and will appear in the list once you upload files into them.`);
      
      fetchFiles(token, currentPath === '/' ? '' : currentPath);
    } catch (error) {
      console.error('Create folder error:', error);
      setError('Failed to create folder.');
    } finally {
      setLoading(false);
    }
  };

  const handleNavigateFolder = async (folderPath) => {
    try {
      const token = await getAccessToken();
      fetchFiles(token, folderPath);
    } catch (error) {
      console.error('Navigation error:', error);
      setError('Failed to navigate folder.');
    }
  };

  const handleRenameItem = async () => {
    if (!renameName.trim()) {
      setError('Name cannot be empty.');
      return;
    }

    try {
      setLoading(true);
      const token = await getAccessToken();
      await axios.post(
        `${API_URL}/api/files/rename`,
        { 
          oldPath: renameTarget.fullPath || renameTarget.name, 
          newName: renameName 
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      setShowRenameDialog(false);
      setRenameTarget(null);
      setRenameName('');
      setError(null);
      fetchFiles(token, currentPath === '/' ? '' : currentPath);
    } catch (error) {
      console.error('Rename error:', error);
      setError('Failed to rename item.');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteFolder = async (folderPath) => {
    if (!window.confirm(`Delete folder and all contents?`)) return;

    try {
      setLoading(true);
      const token = await getAccessToken();
      await axios.delete(
        `${API_URL}/api/files/folders/${encodeURIComponent(folderPath)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      fetchFiles(token, currentPath === '/' ? '' : currentPath);
      setError(null);
    } catch (error) {
      console.error('Delete folder error:', error);
      setError('Failed to delete folder.');
    } finally {
      setLoading(false);
    }
  };

  const navigateUp = async () => {
    if (currentPath === '/') return;
    const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
    await handleNavigateFolder(parentPath === '/' ? '' : parentPath);
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

      {uploadProgress && (
        <div className="upload-progress">
          <p>Uploading {uploadProgress.filename}...</p>
          <progress value={uploadProgress.current} max={uploadProgress.total}></progress>
          <span>
            {uploadProgress.current} / {uploadProgress.total} chunks 
            ({Math.round(uploadProgress.current / uploadProgress.total * 100)}%)
          </span>
          {uploadProgress.committing && <span> - Committing...</span>}
        </div>
      )}

      {userRoles.isUploader && (
        <div className="upload-section">
          <div className="upload-controls">
            <div>
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
            <div className="folder-controls">
              <button 
                onClick={() => setShowCreateFolder(true)} 
                disabled={loading}
                className="btn-create-folder"
              >
                + New Folder
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreateFolder && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Create New Folder</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              onKeyPress={(e) => e.key === 'Enter' && handleCreateFolder()}
            />
            <div className="dialog-actions">
              <button onClick={handleCreateFolder} disabled={loading || !newFolderName.trim()}>
                Create
              </button>
              <button onClick={() => {
                setShowCreateFolder(false);
                setNewFolderName('');
              }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenameDialog && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Rename {renameTarget?.type === 'folder' ? 'Folder' : 'File'}</h3>
            <input
              type="text"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder="New name"
              onKeyPress={(e) => e.key === 'Enter' && handleRenameItem()}
            />
            <div className="dialog-actions">
              <button onClick={handleRenameItem} disabled={loading || !renameName.trim()}>
                Rename
              </button>
              <button onClick={() => {
                setShowRenameDialog(false);
                setRenameTarget(null);
                setRenameName('');
              }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="files-section">
        <div className="breadcrumb">
          <button onClick={navigateUp} disabled={currentPath === '/'} className="breadcrumb-btn">
            ← Back
          </button>
          <span className="breadcrumb-path">
            {currentPath === '/' ? '/' : currentPath}
          </span>
        </div>

        {loading && <p>Loading...</p>}
        
        {folders.length === 0 && files.length === 0 && !loading && (
          <p>No folders or files yet.</p>
        )}

        {folders.length > 0 && (
          <div className="folders-section">
            <h3>Folders</h3>
            <ul className="item-list">
              {folders.map((folder) => (
                <li key={folder.path} className="item folder-item">
                  <div className="item-info" onClick={() => handleNavigateFolder(folder.path)}>
                    <span className="item-icon">📁</span>
                    <span className="item-name">{folder.name}</span>
                    <span className="item-meta">({folder.children} items)</span>
                  </div>
                  {userRoles.isUploader && (
                    <div className="item-actions">
                      <button 
                        onClick={() => {
                          setRenameTarget(folder);
                          setRenameName(folder.name);
                          setShowRenameDialog(true);
                        }}
                        disabled={loading}
                        title="Rename"
                      >
                        ✏️
                      </button>
                      <button 
                        onClick={() => handleDeleteFolder(folder.path)}
                        disabled={loading}
                        title="Delete"
                      >
                        🗑️
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {files.length > 0 && (
          <div className="files-list-section">
            <h3>Files</h3>
            <ul className="item-list">
              {files.map((file) => (
                <li key={file.fullPath || file.name} className="item file-item">
                  <div className="item-info">
                    <span className="item-icon">📄</span>
                    <span className="item-name">{file.name}</span>
                    <span className="item-meta">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                  </div>
                  <div className="item-actions">
                    <button 
                      onClick={() => handleDownload(file.fullPath || file.name)} 
                      disabled={loading}
                      title="Download"
                    >
                      ⬇️
                    </button>
                    {userRoles.isUploader && (
                      <>
                        <button 
                          onClick={() => {
                            setRenameTarget(file);
                            setRenameName(file.name);
                            setShowRenameDialog(true);
                          }}
                          disabled={loading}
                          title="Rename"
                        >
                          ✏️
                        </button>
                        <button 
                          onClick={() => handleDelete(file.fullPath || file.name)}
                          disabled={loading}
                          title="Delete"
                        >
                          🗑️
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileManager;
