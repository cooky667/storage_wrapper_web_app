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
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [moveTarget, setMoveTarget] = useState(null);
  const [moveDestination, setMoveDestination] = useState('');
  const [treeCache, setTreeCache] = useState({}); // path -> { folders: [] }
  const [expandedPaths, setExpandedPaths] = useState(new Set(['/']));
  const [quickPath, setQuickPath] = useState('/');
  const [userRoles, setUserRoles] = useState({
    isReader: false,
    isUploader: false,
    isAdmin: false,
  });
  const [showAccessInfo, setShowAccessInfo] = useState(false);
  const [accessInfoFile, setAccessInfoFile] = useState(null);

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

  // Load children folders for a given path into the tree cache
  // duplicate removed

  // Fetch files and folders
  // eslint-disable-next-line no-use-before-define
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
      // Cache tree nodes for the current path
      setTreeCache((prev) => ({
        ...prev,
        [response.data.currentPath || '/']:
          { folders: response.data.folders || [] }
      }));
      // Ensure tree has root cached as well
      if ((response.data.currentPath || '/') !== '/') {
        try {
          const rootResp = await axios.get(`${API_URL}/api/files`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          setTreeCache((prev) => ({
            ...prev,
            [rootResp.data.currentPath || '/']:
              { folders: rootResp.data.folders || [] }
          }));
        } catch (e) {
          console.warn('Failed to refresh root tree:', e?.message || e);
        }
      }
      // Auto-expand the current path so users can see children
      setExpandedPaths((prev) => new Set([...Array.from(prev), (response.data.currentPath || '/') ]));
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
        folder: currentPath === '/' ? '' : currentPath,
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
        folder: currentPath === '/' ? '' : currentPath,
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

  // loadTreeChildren declared above

  const toggleExpand = async (path) => {
    const next = new Set(expandedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!treeCache[path]) {
        try {
          const token = await getAccessToken();
          const qPath = path === '/' ? '' : path;
          const query = qPath && qPath !== '/' ? `?folder=${encodeURIComponent(qPath)}` : '';
          const resp = await axios.get(`${API_URL}/api/files${query}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          setTreeCache((prev) => ({
            ...prev,
            [resp.data.currentPath || '/']:
              { folders: resp.data.folders || [] }
          }));
        } catch (e) {
          console.warn('Failed to load tree node:', e?.message || e);
        }
      }
    }
    setExpandedPaths(next);
  };

  const navigateToPath = async (path) => {
    try {
      const token = await getAccessToken();
      await fetchFiles(token, path === '/' ? '' : path);
    } catch (error) {
      console.error('Navigate path error:', error);
      setError('Failed to navigate to path.');
    }
  };

  // Always load root children once initialized so sidebar shows content
  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessToken();
        const rootResp = await axios.get(`${API_URL}/api/files`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setTreeCache((prev) => ({
          ...prev,
          [rootResp.data.currentPath || '/']:
            { folders: rootResp.data.folders || [] }
        }));
      } catch (e) {
        console.warn('Failed to preload root tree:', e?.message || e);
      }
    })();
  }, [API_URL, getAccessToken]);

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
        fetchFiles(token, currentPath === '/' ? '' : currentPath);
        return;
      }

      // Standard upload for smaller files
      const formData = new FormData();
      formData.append('file', selectedFile);

      const targetFolder = currentPath === '/' ? '' : currentPath;
      const response = await axios.post(
        `${API_URL}/api/files${targetFolder ? `?folder=${encodeURIComponent(targetFolder)}` : ''}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            // Do NOT set Content-Type for FormData; browser adds boundary automatically
          },
        }
      );

      const startedPath = response?.data?.path
        || (targetFolder ? `${targetFolder}/${selectedFile.name}` : selectedFile.name);
      setSelectedFile(null);
      setError(null);

      // Poll for existence until blob appears, then refresh list
      const pollIntervalMs = 3000;
      const maxAttempts = 100; // ~5 minutes
      let attempts = 0;
      const intervalId = setInterval(async () => {
        attempts += 1;
        try {
          const existsResp = await axios.get(`${API_URL}/api/files/exists/${encodeURIComponent(startedPath)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (existsResp?.data?.exists) {
            clearInterval(intervalId);
            fetchFiles(token, currentPath === '/' ? '' : currentPath);
          } else if (attempts >= maxAttempts) {
            clearInterval(intervalId);
            console.warn('Polling timed out for', startedPath);
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
      const path = filename.includes('/')
        ? filename
        : (currentPath === '/' ? filename : `${currentPath}/${filename}`);

      // Request a short-lived download token, then let the browser stream directly from the API
      const bearer = await getAccessToken();
      const tokenResp = await axios.post(
        `${API_URL}/api/files/download-token`,
        { path },
        { headers: { Authorization: `Bearer ${bearer}` } }
      );

      const downloadToken = tokenResp?.data?.token;
      if (!downloadToken) {
        throw new Error('No download token returned');
      }

      const encodedPath = encodeURIComponent(path);
      const url = `${API_URL}/api/files/${encodedPath}?dt=${encodeURIComponent(downloadToken)}`;

      // Use an anchor so the browser handles streaming; avoids buffering large files in memory
      const link = document.createElement('a');
      link.href = url;
      link.download = path.split('/').pop() || filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
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
      
      // Optimistically add virtual folder to UI and tree cache
      const newFolder = { name: newFolderName, path: folderPath, type: 'folder', children: 0 };
      setFolders((prev) => {
        // Avoid duplicates
        if (prev.find((f) => f.path === folderPath)) return prev;
        return [...prev, newFolder];
      });
      setTreeCache((prev) => {
        const key = currentPath === '/' ? '/' : currentPath;
        const existing = prev[key]?.folders || [];
        const already = existing.find((f) => f.path === folderPath);
        const nextFolders = already ? existing : [...existing, newFolder];
        return { ...prev, [key]: { folders: nextFolders } };
      });
      // Ensure current path expanded so the new folder is visible
      setExpandedPaths((prev) => new Set([...Array.from(prev), (currentPath === '/' ? '/' : currentPath)]));

      setNewFolderName('');
      setShowCreateFolder(false);
      setError(null);
      
      // Folder persists via .keep marker blob
      alert(`Folder "${newFolderName}" created successfully!`);
      
      // Refresh to show the newly created folder
      await fetchFiles(currentPath);
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

  const handleMoveFile = async () => {
    if (!moveDestination.trim()) {
      setError('Destination folder cannot be empty.');
      return;
    }

    try {
      setLoading(true);
      const token = await getAccessToken();
      const destPath = normalizePathForClient(moveDestination) + '/' + (moveTarget.name || moveTarget.fullPath.split('/').pop());
      await axios.post(
        `${API_URL}/api/files/move`,
        { sourcePath: moveTarget.fullPath || moveTarget.name, destinationPath: destPath },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setShowMoveDialog(false);
      setMoveTarget(null);
      setMoveDestination('');
      setError(null);
      fetchFiles(token, currentPath === '/' ? '' : currentPath);
    } catch (error) {
      console.error('Move error:', error);
      setError('Failed to move file.');
    } finally {
      setLoading(false);
    }
  };

  const normalizePathForClient = (p) => {
    if (!p) return '';
    return p.replace(/^\/+/,'').replace(/\/+$/,'');
  };

  const handleDeleteFolder = async (folderPath) => {
    if (!window.confirm(`Delete empty folder? (Folder must not contain any files)`)) return;

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
      const msg = error.response?.data?.error || 'Failed to delete folder.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleShowAccessInfo = (file) => {
    setAccessInfoFile(file);
    setShowAccessInfo(true);
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      alert('Copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy:', err);
    });
  };

  const navigateUp = async () => {
    if (currentPath === '/') return;
    const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
    await handleNavigateFolder(parentPath === '/' ? '' : parentPath);
  };

  return (
    <div className="file-manager">
      <div className="layout">
        <aside className="sidebar">
          <h3>Folder Tree</h3>
          <div className="quick-path">
            <input
              type="text"
              value={quickPath}
              onChange={(e) => setQuickPath(e.target.value)}
              placeholder="Enter folder path"
            />
            <button onClick={() => navigateToPath(quickPath)}>Go</button>
          </div>
          <ul className="tree">
            <TreeNode 
              path="/" 
              name="/" 
              expanded={expandedPaths.has('/')} 
              onToggle={() => toggleExpand('/')} 
              onSelect={() => navigateToPath('/')} 
              childrenFolders={treeCache['/']?.folders || []} 
              expandedPaths={expandedPaths}
              onNavigate={navigateToPath}
              onToggleExpand={toggleExpand}
              treeCache={treeCache}
              loadChildren={async () => {}}
            />
          </ul>
        </aside>
        <main className="content">
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
          {userRoles.isUploader && (
            <div className="breadcrumb-actions">
              <button 
                onClick={() => setShowCreateFolder(true)} 
                disabled={loading}
                className="btn-create-folder"
              >
                + New Folder
              </button>
            </div>
          )}
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
                    <button 
                      onClick={() => handleShowAccessInfo(file)} 
                      disabled={loading}
                      title="Show API Access Info"
                    >
                      🔗
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
                          onClick={() => {
                            setMoveTarget(file);
                            setMoveDestination(currentPath === '/' ? '' : currentPath);
                            setShowMoveDialog(true);
                          }}
                          disabled={loading}
                          title="Move"
                        >
                          📦
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

          {showMoveDialog && (
            <div className="dialog-overlay">
              <div className="dialog">
                <h3>Move File</h3>
                <p>File: {moveTarget?.fullPath || moveTarget?.name}</p>
                <input
                  type="text"
                  value={moveDestination}
                  onChange={(e) => setMoveDestination(e.target.value)}
                  placeholder="Destination folder path"
                />
                <div className="dialog-actions">
                  <button onClick={handleMoveFile} disabled={loading || !moveDestination.trim()}>
                    Move
                  </button>
                  <button onClick={() => { setShowMoveDialog(false); setMoveTarget(null); setMoveDestination(''); }}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* API Access Info Dialog */}
          {showAccessInfo && accessInfoFile && (
            <div className="dialog-backdrop" onClick={() => setShowAccessInfo(false)}>
              <div className="dialog" onClick={(e) => e.stopPropagation()}>
                <h3>API Access Info: {accessInfoFile.name}</h3>
                
                <div style={{ marginBottom: '20px' }}>
                  <h4>Download URL:</h4>
                  <code style={{ display: 'block', padding: '10px', background: '#f5f5f5', borderRadius: '4px', wordBreak: 'break-all' }}>
                    {API_URL}/api/files/{accessInfoFile.fullPath || accessInfoFile.name}
                  </code>
                  <button onClick={() => copyToClipboard(`${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}`)}>
                    Copy URL
                  </button>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <h4>PowerShell (VM with Managed Identity):</h4>
                  <pre style={{ padding: '10px', background: '#f5f5f5', borderRadius: '4px', overflow: 'auto', fontSize: '12px' }}>
{`# Get token using VM's managed identity
$response = Invoke-RestMethod -Uri 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api://f7c08d7c-21c1-4078-ba83-00291a290457' -Headers @{Metadata="true"}
$token = $response.access_token

# Download file
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri "${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}" -Headers $headers -OutFile "${accessInfoFile.name}"`}
                  </pre>
                  <button onClick={() => copyToClipboard(`# Get token using VM's managed identity\n$response = Invoke-RestMethod -Uri 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api://f7c08d7c-21c1-4078-ba83-00291a290457' -Headers @{Metadata="true"}\n$token = $response.access_token\n\n# Download file\n$headers = @{ Authorization = "Bearer $token" }\nInvoke-RestMethod -Uri "${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}" -Headers $headers -OutFile "${accessInfoFile.name}"`)}>
                    Copy PowerShell
                  </button>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <h4>Python (VM with Managed Identity):</h4>
                  <p style={{ fontSize: '12px', color: '#666', marginBottom: '10px' }}>First, install dependencies: <code>pip install azure-identity requests</code></p>
                  <pre style={{ padding: '10px', background: '#f5f5f5', borderRadius: '4px', overflow: 'auto', fontSize: '12px' }}>
{`from azure.identity import DefaultAzureCredential
import requests

# Get token using VM's managed identity
credential = DefaultAzureCredential()
token = credential.get_token("api://f7c08d7c-21c1-4078-ba83-00291a290457/.default")

# Download file with streaming (memory-efficient for large files)
headers = {"Authorization": f"Bearer {token.token}"}
response = requests.get("${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}", headers=headers, stream=True)

with open("${accessInfoFile.name}", "wb") as f:
    for chunk in response.iter_content(chunk_size=8192):
        if chunk:
            f.write(chunk)`}
                  </pre>
                  <button onClick={() => copyToClipboard(`from azure.identity import DefaultAzureCredential\nimport requests\n\n# Get token using VM's managed identity\ncredential = DefaultAzureCredential()\ntoken = credential.get_token("api://f7c08d7c-21c1-4078-ba83-00291a290457/.default")\n\n# Download file with streaming (memory-efficient for large files)\nheaders = {"Authorization": f"Bearer {token.token}"}\nresponse = requests.get("${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}", headers=headers, stream=True)\n\nwith open("${accessInfoFile.name}", "wb") as f:\n    for chunk in response.iter_content(chunk_size=8192):\n        if chunk:\n            f.write(chunk)`)}>
                    Copy Python
                  </button>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <h4>cURL (VM with Managed Identity):</h4>
                  <pre style={{ padding: '10px', background: '#f5f5f5', borderRadius: '4px', overflow: 'auto', fontSize: '12px' }}>
{`# Get token using VM's managed identity
TOKEN=$(curl -s 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api://f7c08d7c-21c1-4078-ba83-00291a290457' -H Metadata:true | grep -Po '"access_token":"\\K[^"]*')

# Download file
curl -H "Authorization: Bearer $TOKEN" \\
  "${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}" \\
  -o "${accessInfoFile.name}"`}
                  </pre>
                  <button onClick={() => copyToClipboard(`# Get token using VM's managed identity\nTOKEN=$(curl -s 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api://f7c08d7c-21c1-4078-ba83-00291a290457' -H Metadata:true | grep -Po '"access_token":"\\K[^"]*')\n\n# Download file\ncurl -H "Authorization: Bearer $TOKEN" \\\n  "${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}" \\\n  -o "${accessInfoFile.name}"`)}>
                    Copy cURL
                  </button>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <h4>Azure CLI (VM with Managed Identity):</h4>
                  <pre style={{ padding: '10px', background: '#f5f5f5', borderRadius: '4px', overflow: 'auto', fontSize: '12px' }}>
{`# Get token using VM's managed identity
TOKEN=$(az account get-access-token --resource api://f7c08d7c-21c1-4078-ba83-00291a290457 --query accessToken -o tsv)

# Download file
curl -H "Authorization: Bearer $TOKEN" \\
  "${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}" \\
  -o "${accessInfoFile.name}"`}
                  </pre>
                  <button onClick={() => copyToClipboard(`# Get token using VM's managed identity\nTOKEN=$(az account get-access-token --resource api://f7c08d7c-21c1-4078-ba83-00291a290457 --query accessToken -o tsv)\n\n# Download file\ncurl -H "Authorization: Bearer $TOKEN" \\\n  "${API_URL}/api/files/${accessInfoFile.fullPath || accessInfoFile.name}" \\\n  -o "${accessInfoFile.name}"`)}>
                    Copy Azure CLI
                  </button>
                </div>

                <button onClick={() => setShowAccessInfo(false)}>Close</button>
              </div>
            </div>
          )}
        </div>
        </main>
      </div>
    </div>
  );
};

// Tree node component
const TreeNode = ({ path, name, expanded, onToggle, onSelect, childrenFolders, expandedPaths, onNavigate, onToggleExpand, treeCache, loadChildren }) => {
  return (
    <li className="tree-node">
      <div className="tree-node-header">
        <button className="toggle-btn" onClick={onToggle}>
          {expanded ? '▾' : '▸'}
        </button>
        <span className="tree-node-name" onClick={onSelect}>{name}</span>
      </div>
      {expanded && childrenFolders && childrenFolders.length > 0 && (
        <ul className="tree-children">
          {childrenFolders.map((f) => (
            <TreeNode
              key={f.path}
              path={f.path}
              name={f.name}
              expanded={expandedPaths.has(f.path)}
              onToggle={async () => {
                await onToggleExpand(f.path);
              }}
              onSelect={() => onNavigate(f.path)}
              childrenFolders={(treeCache[f.path] && treeCache[f.path].folders) || []}
              expandedPaths={expandedPaths}
              onNavigate={onNavigate}
              onToggleExpand={onToggleExpand}
              treeCache={treeCache}
              loadChildren={loadChildren}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

export default FileManager;
