const https = require('https');
const WebSocket = require('ws');
const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const logger = require('./logger');
const { setInterval } = require('timers');

// Load SSL certificate and private key
const server = https.createServer({
    // cert: fs.readFileSync('/home/alphawizzserver/ssl/certs/www_utmessenger_com_c44b7_01f67_1746077243_c8f3f43e48059a0028b5217fa9b69f35.crt'), // Replace with your certificate file
    // key: fs.readFileSync('/home/alphawizzserver/ssl/keys/c44b7_01f67_f4f5b8d0c1f5accc0371744875af07a7.key') // Replace with your private key file
});

// Initialize Firebase Admin SDK
const serviceAccount = require(path.join(__dirname, '/utchat-1548b-firebase-adminsdk-8noxd-4979958265.json'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const messaging = admin.messaging();

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',     // Change this to your MySQL username
    password: '',     // Change this to your MySQL password
    database: 'websocket_chat',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});
const promisePool = pool.promise();
  
  // Function to query the database
function queryDatabase(query, params) {
    return new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
            if (err) {
                console.error('Error getting database connection:', err);
                reject(err); // Reject the promise on error
                return;
            }

            // Execute the query
            connection.query(query, params, (error, results) => {
                connection.release(); // Release connection back to the pool

                if (error) {
                    console.error('Query error:', error);
                    reject(error);
                } else {
                    resolve(results);
                }
            });
        });
    });
}

// Connect to database
//db.connect((err) => {
//    if (err) {

//        logger.info('Database connection error:', err);

//        console.error('Database connection error:', err);
//        process.exit(1);
//    }

//    logger.info('Connected to the MySQL database | ');

//    console.log('Connected to the MySQL database');
//});  

// Create WebSocket server
const wss = new WebSocket.Server({ port: 8080 });
// const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New client connected');

    logger.info('New client connected | ');

    // Listen for incoming messages from the client
    ws.on('message', (message) => {
        const parsedMessage = JSON.parse(message);

        const query = 'SELECT * FROM users WHERE id = ?';
        const params = [1];
        queryDatabase(query, params).then(() => {}).catch(() =>{});

        // Message seen acknowledge
        if (parsedMessage.type === 'ack_seen') {
            const { messageId, sender, receiver_user } = parsedMessage;

            logger.info('New client connected | ' + (pool) + '|' + message);

            // Update status to 'seen' in the database
            // Update status to 'seen' in the database
            queryDatabase(
                `UPDATE chat_message 
                SET current_status = 4 
                WHERE id = ?`,
                [messageId]
            ).then(() => {
                logger.info('Update status to seen in the database');

                // Notify the sender about the read receipt
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(
                            JSON.stringify({
                                type: 'read_receipt',
                                messageId,
                                sender,
                                receiver_user,
                            })
                        );
                    }
                });
            }).catch((err) => {
                logger.info('Error updating message status to seen:', err);
                console.error('Error updating message status to seen:', err);
            });
        }

        // Live chat typing message
        if (parsedMessage.type === 'typing') {
            const { sender, receiver_user, isTyping } = parsedMessage;

            // Broadcast typing status to the receiver
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(
                        JSON.stringify({
                            type: 'typing',
                            sender,
                            receiver_user,
                            isTyping,
                        })
                    );
                }
            });
        }

        // Live chat Message handler
        if (parsedMessage.type === 'chat') {
            const { user_type, receiver_user, sender, content, messageType, room_id, chat_type, sender_name } = parsedMessage; // `messageType` for distinguishing 1 (text) or 2 (media)

            logger.info(`User Chatting .... sender : ${sender} ${sender_name} | roomId ${room_id} | .... receiver_user : ${receiver_user} | ${chat_type}`);

            if (room_id !== '') {
                if (chat_type === 'broadcast') {
                    saveBroadcastGroupMessage(room_id, content, messageType, sender_name);
                    saveBroadcastGroupPersonalMessage(room_id, sender, receiver_user, content, messageType, sender_name);
                } else {
                    saveGroupMessage(room_id, sender, receiver_user, content, messageType, sender_name);
                }
            } else {
                logger.info(`Room not Exists ----------------- User Chatting .... sender : ${sender} ${sender_name} | roomId ${room_id} | .... receiver_user : ${receiver_user} | ${chat_type}`);

                queryDatabase(
                    `SELECT c1.room_id 
                    FROM chat_room_user c1 
                    LEFT JOIN chat_room_user c2 ON c1.room_id = c2.room_id 
                    LEFT JOIN chat_room ON chat_room.id = c1.room_id 
                    WHERE chat_room.type = 1 
                    AND c1.user_id IN (?, ?) 
                    AND c2.user_id IN (?, ?)
                    GROUP BY c1.room_id 
                    HAVING COUNT(DISTINCT c1.user_id) = 2`,
                    [receiver_user, sender, receiver_user, sender]
                ).then((roomResult) => {
                    if (roomResult.length > 0) {
                        const newRoomId = roomResult[0].room_id;
                        var is_admin = user_type === 'admin' ? 1 : 0;
                        const roomUsers = [
                            [newRoomId, sender, is_admin],
                            [newRoomId, receiver_user, 0]
                        ];

                        // return queryDatabase('INSERT INTO chat_room_user (room_id, user_id, is_admin) VALUES ?', [roomUsers])
                        //     .then(() => {
                                logger.info(`New room created and users added: ${newRoomId}`);
                                // saveMessage(newRoomId, sender, receiver_user, content, messageType, sender_name);
                                saveGroupMessage(newRoomId, sender, receiver_user, content, messageType, sender_name);
                            // });
                    } else {
                        const newRoom = [[1]];
                        return queryDatabase('INSERT INTO chat_room (type) VALUES ?', [newRoom])
                            .then((result) => {
                                const newRoomId = result.insertId;
                                var is_admin = user_type === 'admin' ? 1 : 0;
                                const roomUsers = [
                                    [newRoomId, sender, is_admin],
                                    [newRoomId, receiver_user, 0]
                                ];

                                return queryDatabase('INSERT INTO chat_room_user (room_id, user_id, is_admin) VALUES ?', [roomUsers])
                                    .then(() => {
                                        logger.info(`New room created and users added: ${newRoomId}`);
                                        // saveMessage(newRoomId, sender, receiver_user, content, messageType, sender_name);
                                        saveGroupMessage(newRoomId, sender, receiver_user, content, messageType, sender_name);
                                    });
                            });
                    }
                }).catch((err) => {
                    logger.info('Error creating new room: ' + err);
                    console.error('Error creating new room:', err);
                });
            }
        }

        // Live File Sharing
        if (parsedMessage.type === 'file') {
            const { room_id, sender, receiver_user, fileName, fileData, chat_type, sender_name } = parsedMessage;

            if (room_id != null) {
                const newRoomId = room_id;
                const content = fileName;
                const filePath = path.join(__dirname, '../storage/app/chat', fileName);
                
                fs.writeFile(filePath, Buffer.from(fileData, 'base64'), (err) => {
                    if (err) {
                        console.error('Error saving file:', err);
                        return;
                    }

                    const uid = 1001; // Replace with desired user ID
                    const gid = 1003; // Replace with desired group ID
                    fs.chown(filePath, uid, gid, (err) => {
                        if (err) {
                            console.error('Error setting file owner/group:', err);
                        } else {
                            console.log('File owner/group updated successfully');
                        }
                    });
                });

                if (chat_type === 'broadcast') {
                    saveBroadcastGroupMessage(newRoomId, content, 2, sender_name);
                    saveBroadcastGroupPersonalMessage(newRoomId, sender, receiver_user, content, 2, sender_name);
                } else {
                    saveGroupMessage(newRoomId, sender, receiver_user, content, 2, sender_name);
                }
            } else {
                queryDatabase('INSERT INTO chat_room (type) VALUES (1)', [])
                    .then((roomResult) => {
                        const newRoomId = roomResult.insertId;
                        const content = fileName;
                        const filePath = path.join(__dirname, '../storage/app/chat', fileName);
                        
                        fs.writeFile(filePath, Buffer.from(fileData, 'base64'), (err) => {
                            if (err) {
                                console.error('Error saving file:', err);
                                return;
                            }

                            const uid = 1001; // Replace with desired user ID
                            const gid = 1003; // Replace with desired group ID
                            fs.chown(filePath, uid, gid, (err) => {
                                if (err) {
                                    console.error('Error setting file owner/group:', err);
                                } else {
                                    console.log('File owner/group updated successfully');
                                }
                            });

                            if (chat_type === 'broadcast') {
                                saveBroadcastGroupMessage(newRoomId, content, 2, sender_name);
                                saveBroadcastGroupPersonalMessage(newRoomId, sender, receiver_user, content, 2, sender_name);
                            } else {
                                saveGroupMessage(newRoomId, sender, receiver_user, content, 2, sender_name);
                            }
                        });
                    })
                    .catch((err) => {
                        console.error('Error creating new room:', err);
                    });
            }
        }

        // Fetch history for the two users
        if (parsedMessage.type === 'fetch_history') {
            const { sender, receiver_user, room_id } = parsedMessage;
            let logged_user = '';
            let chat_user = '';

            if (room_id !== '') {
                queryDatabase(
                    'UPDATE `chat_message_user` LEFT JOIN `chat_message` ON `chat_message`.`id` = `chat_message_user`.`chat_message_id` SET `chat_message_user`.`status` = 4 WHERE `chat_message`.`room_id` = ? AND `chat_message_user`.`user_id` = ?', 
                    [room_id, sender]
                )
                .then((resp) => {
                    logger.info(resp, 'Message marked as read');
                })
                .catch((err) => {
                    logger.info(err, 'Error updating message status');
                });

                queryDatabase(
                    `SELECT users.name as sender_name, cm.id, cm.message, cm.type, cm.created_by, cm.created_at
                    FROM chat_message cm
                    JOIN chat_message_user ON chat_message_user.chat_message_id = cm.id
                    JOIN users ON users.id = cm.created_by
                    WHERE cm.room_id = ? AND chat_message_user.user_id = ?
                    ORDER BY cm.created_at ASC`, 
                    [room_id, sender]
                )
                .then((chatResults) => {
                    ws.send(
                        JSON.stringify({
                            type: 'history',
                            room_id: room_id,
                            logged_user: logged_user,
                            chat_user: chat_user,
                            messages: chatResults
                        })
                    );
                })
                .catch((err) => {
                    logger.info(err, 'Error fetching chat history');
                });
            } else {
                queryDatabase(
                    `SELECT room_id 
                    FROM chat_room_user 
                    WHERE user_id IN (?, ?) 
                    GROUP BY room_id 
                    HAVING COUNT(DISTINCT user_id) = 2`, 
                    [sender, receiver_user]
                )
                .then((results) => {
                    if (results.length > 0) {
                        const roomId = results[0].room_id;

                        queryDatabase(
                            'UPDATE `chat_message_user` LEFT JOIN `chat_message` ON `chat_message`.`id` = `chat_message_user`.`chat_message_id` SET `chat_message_user`.`status` = 4 WHERE `chat_message`.`room_id` = ? AND `chat_message_user`.`user_id` = ?', 
                            [roomId, sender]
                        )
                        .then((resp) => {
                            logger.info(resp, 'Message marked as read');
                        })
                        .catch((err) => {
                            logger.info(err, 'Error updating message status');
                        });

                        queryDatabase(
                            `SELECT users.name as sender_name, cm.id, cm.message, cm.type, cm.created_by, cm.created_at
                            FROM chat_message cm
                            JOIN chat_message_user ON chat_message_user.chat_message_id = cm.id
                            JOIN users ON users.id = cm.created_by
                            WHERE cm.room_id = ? AND chat_message_user.user_id = ?
                            ORDER BY cm.created_at ASC`, 
                            [roomId, sender]
                        )
                        .then((chatResults) => {
                            ws.send(
                                JSON.stringify({
                                    type: 'history',
                                    room_id: roomId,
                                    logged_user: logged_user,
                                    chat_user: chat_user,
                                    messages: chatResults
                                })
                            );
                        })
                        .catch((err) => {
                            logger.info(err, 'Error fetching chat history');
                        });
                    } else {
                        ws.send(
                            JSON.stringify({
                                type: 'history',
                                room_id: null,
                                messages: [],
                            })
                        );
                    }
                })
                .catch((err) => {
                    logger.info('Error fetching room ID:', err);
                });
            }
        }

        // Fetch history for the two users
        if (parsedMessage.type === 'delete') {
            const { sender, receiver_user, room_id, message_id } = parsedMessage;
            let logged_user = '';
            let chat_user = '';
            const message_ids = message_id.split(',');

            queryDatabase('DELETE FROM chat_message WHERE id IN (?)', [message_ids])
                .then(() => {
                    console.log('Message deleted');
                })
                .catch((err) => {
                    console.error('Error deleting message:', err);
                });

            queryDatabase('DELETE FROM chat_message_user WHERE chat_message_id IN (?)', [message_ids])
                .then(() => {
                    console.log('Message deleted for users');
                })
                .catch((err) => {
                    console.error('Error deleting message for users:', err);
                });

            if (room_id !== '') {
                queryDatabase('UPDATE `chat_message_user` LEFT JOIN `chat_message` ON `chat_message`.`id` = `chat_message_user`.`chat_message_id` SET `chat_message_user`.`status` = 4 WHERE `chat_message`.`room_id` = ? AND `chat_message_user`.`user_id` = ?', [room_id, sender])
                    .then(() => {
                        console.log('Message read success', room_id, sender);
                    })
                    .catch((err) => {
                        console.error('Error updating message status:', err);
                    });

                queryDatabase(
                    `SELECT users.name as sender_name, cm.id, cm.message, cm.type, cm.created_by, cm.created_at
                    FROM chat_message cm
                    JOIN chat_message_user ON chat_message_user.chat_message_id = cm.id
                    JOIN users ON users.id = cm.created_by
                    WHERE cm.room_id = ? AND chat_message_user.user_id = ?
                    ORDER BY cm.created_at ASC`,
                    [room_id, sender]
                )
                    .then((chatResults) => {
                        console.log('User history loaded successfully');
                        wss.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(
                                    JSON.stringify({
                                        type: 'history',
                                        room_id: room_id,
                                        logged_user: logged_user,
                                        chat_user: chat_user,
                                        messages: chatResults,
                                    })
                                );
                            }
                        });
                    })
                    .catch((err) => {
                        console.error('Error fetching chat history:', err);
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch chat history 4.' }));
                    });
            } else {
                queryDatabase('SELECT name FROM users WHERE id IN (?)', [sender])
                    .then((results) => {
                        logged_user = results[0]?.name ?? 'Unknown user';
                    })
                    .catch((err) => {
                        console.error('Error fetching sender name:', err);
                    });

                queryDatabase('SELECT name FROM users WHERE id IN (?)', [receiver_user])
                    .then((results) => {
                        chat_user = results[0]?.name ?? 'Unknown user';
                    })
                    .catch((err) => {
                        console.error('Error fetching receiver name:', err);
                    });

                queryDatabase(
                    `SELECT room_id FROM chat_room_user WHERE user_id IN (?, ?) GROUP BY room_id HAVING COUNT(DISTINCT user_id) = 2`,
                    [sender, receiver_user]
                )
                    .then((results) => {
                        if (results.length > 0) {
                            const roomId = results[0].room_id;
                            queryDatabase('UPDATE `chat_message_user` LEFT JOIN `chat_message` ON `chat_message`.`id` = `chat_message_user`.`chat_message_id` SET `chat_message_user`.`status` = 4 WHERE `chat_message`.`room_id` = ? AND `chat_message_user`.`user_id` = ?', [roomId, sender])
                                .then(() => {
                                    console.log('Message read success', roomId, sender);
                                })
                                .catch((err) => {
                                    console.error('Error updating message status:', err);
                                });

                            queryDatabase(
                                `SELECT cm.id, cm.message, cm.type, cm.created_by, cm.created_at
                                FROM chat_message cm
                                JOIN chat_message_user ON chat_message_user.chat_message_id = cm.id
                                WHERE cm.room_id = ? AND chat_message_user.user_id = ?
                                ORDER BY cm.created_at ASC`,
                                [roomId, sender]
                            )
                                .then((chatResults) => {
                                    ws.send(
                                        JSON.stringify({
                                            type: 'history',
                                            room_id: roomId,
                                            logged_user: logged_user,
                                            chat_user: chat_user,
                                            messages: chatResults,
                                        })
                                    );
                                })
                                .catch((err) => {
                                    console.error('Error fetching chat history:', err);
                                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch chat history 4.' }));
                                });
                        } else {
                            ws.send(
                                JSON.stringify({
                                    type: 'history',
                                    room_id: null,
                                    messages: [],
                                })
                            );
                        }
                    })
                    .catch((err) => {
                        console.error('Error fetching room ID:', err);
                    });
            }
        }

    });

    // Function to save a message in the database and broadcast it
    async function saveBMessage(roomId, sender, receiver_user, content, messageType, sender_name) {
        logger.info(`saveBMessage()    (${roomId}, ${sender}, ${receiver_user}, ${content}, ${messageType}, ${sender_name})`);

        try {
            // Insert message into chat_message table
            const messageResult = await queryDatabase(
                `INSERT INTO chat_message (room_id, type, message, is_encrypted, current_status, created_by) VALUES (?, ?, ?, 0, 1, ?)`,
                [roomId, messageType, content, sender]
            );

            logger.info(`saveBMessage() --------------- 'New Message sent, ${JSON.stringify(messageResult)}`);

            const chatMessageId = messageResult.insertId;

            // Insert status for both users into chat_message_user table
            const messageUsers = [
                [chatMessageId, sender, 4], // Sender: read status
                [chatMessageId, receiver_user, 1] // Receiver: not received status
            ];

            await queryDatabase(
                'INSERT INTO chat_message_user (chat_message_id, user_id, status) VALUES ?',
                [messageUsers]
            );

            logger.info(`saveBMessage() --------------- 'Message user statuses inserted: ${JSON.stringify(messageUsers)}`);

            const userResult = await queryDatabase(
                'SELECT cm_firebase_token FROM users WHERE id = ?',
                [receiver_user]
            );

            if (userResult.length > 0) {
                const token = userResult[0].cm_firebase_token;
                sendNotification(messaging, token, 'New message received');
                logger.info(`saveBMessage() --------------- 'Notification sent to ${receiver_user}`);
            }

        } catch (err) {
            logger.error(`saveBMessage() --------------- Error saving message: ${err}`);
            console.error('Error in saveBMessage:', err);
        }
    }

    // Function to save a group message in the database and broadcast it
    async function saveGroupMessage(roomId, sender, receiver_user, content, messageType, sender_name) {
        logger.info(`saveGroupMessage() (${roomId}, ${sender}, ${receiver_user}, ${content}, ${messageType}, ${sender_name})`);

        try {
            // Insert message into chat_message table
            const messageResult = await queryDatabase(
                `INSERT INTO chat_message (room_id, type, message, is_encrypted, current_status, created_by) VALUES (?, ?, ?, 0, 1, ?)`,
                [roomId, messageType, content, sender]
            );

            const chatMessageId = messageResult.insertId;
            logger.info(`New Message created: ${chatMessageId}`);

            // Fetch all user IDs in the chat room
            const groupUsers = await queryDatabase(
                'SELECT user_id FROM chat_room_user WHERE room_id = ?',
                [roomId]
            );

            if (groupUsers.length === 0) {
                logger.info(`No users found in the group: ${roomId}`);
                console.error('No users found in the group.');
                return;
            }

            const userIds = groupUsers.map(user => user.user_id);
            logger.info(`Group users found: ${JSON.stringify(userIds)}`);

            // Filter out blocked users
            const filteredUserIds = userIds;
            // await Promise.all(
            //     userIds.map(async (userId) => {
            //         const blockResult = await queryDatabase(
            //             'SELECT * FROM user_blocks WHERE friend_id = ? AND user_id = ?',
            //             [sender, userId]
            //         );

            //         if (blockResult.length === 0) {
            //             filteredUserIds.push(userId);
            //             console.log(`User ${userId} will receive the message`);
            //         } else {
            //             logger.info(`User ${userId} has blocked the sender. Skipping...`);
            //         }
            //     })
            // );

            // Insert the message statuses into chat_message_user
            const messageUsers = filteredUserIds.map(userId => [
                chatMessageId,
                userId,
                userId == sender ? 4 : 1 // Sender: read, Others: not received
            ]);

            await queryDatabase(
                'INSERT INTO chat_message_user (chat_message_id, user_id, status) VALUES ?',
                [messageUsers]
            );

            logger.info(`Message statuses saved: ${JSON.stringify(messageUsers)}`);

            // Send notifications to the users who didn't block the sender
            await Promise.all(
                filteredUserIds.map(async (userId) => {
                    logger.info(`Notification not send to ${userId} ${sender}`);
                    if (userId != sender) {
                        const userResult = await queryDatabase(
                            'SELECT cm_firebase_token FROM users WHERE id = ?',
                            [userId]
                        );

                        if (userResult.length > 0) {
                            const token = userResult[0].cm_firebase_token;
                            sendNotification(messaging, token, 'New message received');
                            logger.info(`Notification sent to ${userId} ${userResult[0].cm_firebase_token}`);
                        }
                    }
                })
            );

            // Broadcast the message to all connected clients
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(
                        JSON.stringify({
                            type: 'chat',
                            room_id: roomId,
                            logged_user: sender,
                            chat_user: receiver_user,
                            friend_users: filteredUserIds.join(','),
                            messages: [{
                                sender_name: sender_name,
                                id: chatMessageId,
                                created_by: parseInt(sender),
                                message: content,
                                type: messageType,
                                created_at: new Date()
                            }]
                        })
                    );
                }
            });

        } catch (err) {
            logger.error(`saveGroupMessage() - Error: ${err}`);
            console.error('Error in saveGroupMessage:', err);
        }
    }


    async function createNewGroupAndSaveMessage(sender, receiver_user, content, messageType, sender_name) {
        console.log('Creating new group and sending message to receiver via broadcast group');
        logger.info('Creating new group and sending message to receiver via broadcast group');
    
        try {
            // Create a new chat room
            const newRoom = [[1]];
            const roomResult = await queryDatabase('INSERT INTO chat_room (type) VALUES ?', [newRoom]);
            const newRoomId = roomResult.insertId;
    
            logger.info(`New room created with ID: ${newRoomId}`);
    
            // Associate users with the new room
            const roomUsers = [
                [newRoomId, sender, 0],
                [newRoomId, receiver_user, 0]
            ];
            await queryDatabase('INSERT INTO chat_room_user (room_id, user_id, is_admin) VALUES ?', [roomUsers]);
    
            // Save the message in the chat room
            logger.info('Saving broadcast message...');
            saveBMessage(newRoomId, sender, receiver_user, content, messageType, sender_name);
        } catch (err) {
            logger.error(`Error creating new group and saving message: ${err}`);
            console.error('Error creating new group and saving message:', err);
        }
    }

    // Function to save a message in the database and broadcast it
    async function saveBroadcastGroupPersonalMessage(roomId, sender, receiver_user, content, messageType, sender_name) {
        try {
            const messageResult = await queryDatabase(
                `INSERT INTO chat_message (room_id, type, message, created_by) VALUES (?, ?, ?, ?)`,
                [roomId, messageType, content, sender]
            );
    
            const chatMessageId = messageResult.insertId;
    
            // Insert status for both users into chat_message_user table
            const messageUsers = [
                [chatMessageId, sender, 4], // Sender: read status
            ];
            await queryDatabase(
                'INSERT INTO chat_message_user (chat_message_id, user_id, status) VALUES ?',
                [messageUsers]
            );
    
            // Broadcast the message to all connected clients
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(
                        JSON.stringify({
                            type: 'chat',
                            room_id: roomId,
                            logged_user: sender,
                            chat_user: receiver_user,
                            messages: [{
                                sender_name: sender_name,
                                id: chatMessageId,
                                created_by: parseInt(sender),
                                message: content,
                                type: messageType,
                                created_at: new Date()
                            }]
                        })
                    );
                }
            });
        } catch (err) {
            logger.error(`Error saving broadcast group personal message: ${err}`);
            console.error('Error saving broadcast group personal message:', err);
        }
    }

    // Function to save a message in the database and broadcast it
    async function saveBroadcastGroupMessage(roomId, content, messageType, sender_name) {
        console.log('Sending broadcast group message...');
    
        try {
            const adminResult = await queryDatabase(
                `SELECT user_id FROM chat_room_user WHERE room_id = ? AND is_admin = ?`,
                [roomId, 1]
            );
            const admin_id = adminResult[0].user_id;
    
            const userResult = await queryDatabase(
                `SELECT user_id FROM chat_room_user WHERE room_id = ? AND is_admin = ?`,
                [roomId, 0]
            );
    
            // Prepare the broadcast user pairs
            let userInRoomIds = [];
            for (let index = 0; index < userResult.length; index++) {
                const uid = userResult[index].user_id;
                console.log('Searching for room id', uid, admin_id);
                userInRoomIds.push([admin_id, uid]);
            }
    
            for (const pair of userInRoomIds) {
                const msgRes = await queryDatabase(
                    `SELECT c1.room_id 
                     FROM chat_room_user c1 
                     LEFT JOIN chat_room_user c2 ON c1.room_id = c2.room_id 
                     LEFT JOIN chat_room ON chat_room.id = c1.room_id 
                     WHERE chat_room.type = 1 
                     AND c1.user_id IN (?,?) 
                     AND c2.user_id IN (?,?)
                     GROUP BY c1.room_id 
                     HAVING COUNT(DISTINCT c1.user_id) = 2`,
                    pair
                );
    
                console.log('Room ID Data:', pair, msgRes);
                if (msgRes.length > 0) {
                    const broadcastid = msgRes[0].room_id;
                    console.log('Broadcasting to room:', broadcastid);
                    saveBMessage(broadcastid, pair[0], pair[1], content, messageType, sender_name);
                } else {
                    console.log('No room found; creating new group.');
                    createNewGroupAndSaveMessage(pair[0], pair[1], content, messageType, sender_name);
                }
            }
        } catch (err) {
            logger.error(`Error saving broadcast group message: ${err}`);
            console.error('Error saving broadcast group message:', err);
        }
    }

    const sendNotification = async (messaging, token, description) => {
        try {
            const message = {
                notification: {
                    title: 'UT Messenger',
                    body: description,
                },
                token: token,
            };
            
            logger.error(`Successfully sent message: ${message}`);
            // messaging.send(message)
            //     .then(response => {
            //         logger.error(`Successfully sent message: ${response}`);

            //         console.log('Successfully sent message:', response);
            //     })
            //     .catch(error => {
            //         logger.error(`Error sending message: ${error}`);

            //         console.error('Error sending message:', error);
            //     });
    
        } catch (error) {
            console.error('Error sending notification:', error);
        }
    }

    // Handle client disconnection
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

server.listen(8088, () => {
    console.log('WebSocket server is running on wss://localhost:8080');
});
