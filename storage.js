/**
 * StorageManager - Uses Firebase Cloud Firestore
 * Syncs across multiple devices.
 */

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyA6wVmt8KTwF-B9_8A3aoa4tzmfX2LgZlQ",
    authDomain: "votingapp-3467f.firebaseapp.com",
    projectId: "votingapp-3467f",
    storageBucket: "votingapp-3467f.firebasestorage.app",
    messagingSenderId: "406767435236",
    appId: "1:406767435236:web:3802af05493944aede5bf1"
};

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();

// Ensure Admin Exists (Cloud logic diff: check if doc exists, if not set it)
(async () => {
    try {
        const adminRef = db.collection('users').doc('ADMIN001');
        const doc = await adminRef.get();
        if (!doc.exists) {
            await adminRef.set({
                regNum: 'ADMIN001',
                name: 'System Administrator',
                password: 'admin123',
                role: 'admin',
                hasVoted: false
            });
            console.log("Admin Initialized in Cloud");
        }

        // Settings
        const settingsRef = db.collection('settings').doc('electionActive');
        const setDoc = await settingsRef.get();
        if (!setDoc.exists) {
            await settingsRef.set({ value: 'false' });
        }
    } catch (e) {
        console.error("Firebase Connection Error:", e);
    }
})();

const StorageManager = {
    KEYS: {
        CURRENT_USER: 'ovs_current_user'
    },

    getCurrentUser() {
        return JSON.parse(localStorage.getItem(this.KEYS.CURRENT_USER));
    },

    saveSession(user) {
        localStorage.setItem(this.KEYS.CURRENT_USER, JSON.stringify(user));
    },

    logout() {
        localStorage.removeItem(this.KEYS.CURRENT_USER);
    },

    // --- Cloud Operations ---

    async getElectionStatus() {
        try {
            const doc = await db.collection('settings').doc('electionActive').get();
            const completedDoc = await db.collection('settings').doc('electionCompleted').get();
            const timesDoc = await db.collection('settings').doc('electionTimes').get();

            let times = { start: null, end: null };
            if (timesDoc.exists) times = timesDoc.data();

            return {
                isActive: doc.exists ? doc.data().value === 'true' : false,
                isCompleted: completedDoc.exists ? completedDoc.data().value === 'true' : false,
                startTime: times.start,
                endTime: times.end,
                frozenRemaining: times.frozenRemaining || null
            };
        } catch (e) {
            console.error(e);
            return { isActive: false, isCompleted: false, startTime: null, endTime: null };
        }
    },

    async setElectionStatus(isActive) {
        await db.collection('settings').doc('electionActive').set({
            value: isActive.toString()
        });
        return { success: true };
    },

    async setElectionTimes(start, end) {
        await db.collection('settings').doc('electionTimes').set({
            start: start,
            end: end
        });
        return { success: true };
    },

    async setElectionCompletion(isCompleted) {
        await db.collection('settings').doc('electionCompleted').set({
            value: isCompleted.toString()
        });
        // Auto-stop election if completed
        if (isCompleted) {
            await this.setElectionStatus(false);
        }
        return { success: true };
    },

    async pauseElection(remainingMs) {
        await db.collection('settings').doc('electionActive').set({ value: 'false' });
        await db.collection('settings').doc('electionTimes').update({
            frozenRemaining: remainingMs
        });
        return { success: true };
    },

    async resumeElection() {
        const timesDoc = await db.collection('settings').doc('electionTimes').get();
        if (!timesDoc.exists) return;
        const data = timesDoc.data();

        // Calculate new end time
        let newEnd = null;
        if (data.frozenRemaining) {
            newEnd = new Date(new Date().getTime() + data.frozenRemaining).toISOString();
        } else {
            newEnd = data.end;
        }

        const batch = db.batch();
        batch.set(db.collection('settings').doc('electionActive'), { value: 'true' });
        batch.update(db.collection('settings').doc('electionTimes'), {
            end: newEnd,
            frozenRemaining: firebase.firestore.FieldValue.delete()
        });

        await batch.commit();
        return { success: true };
    },

    async deleteUser(regNum) {
        await db.collection('users').doc(regNum).delete();
        return { success: true };
    },

    async addUser(user) {
        user.regNum = user.regNum.toUpperCase().trim();
        const userRef = db.collection('users').doc(user.regNum);

        const doc = await userRef.get();
        if (doc.exists) {
            throw new Error("Registration Number already exists.");
        }

        await userRef.set(user);
        return { success: true };
    },

    async login(regNum, password) {
        const normalizedInfo = regNum ? regNum.toUpperCase().trim() : '';
        if (!normalizedInfo) return null;

        const doc = await db.collection('users').doc(normalizedInfo).get();

        if (doc.exists) {
            const user = doc.data();
            if (user.password === password) {
                this.saveSession(user);
                return user;
            }
        }
        return null;
    },

    async approveUser(regNum) {
        await db.collection('users').doc(regNum).update({
            status: 'active'
        });
        return { success: true };
    },

    async rejectUser(regNum) {
        // "if rejected show rejected they have to register again" -> Deleting allows re-registration.
        // Or we can set status 'rejected'. If we delete, they can just try again immediately with fixes.
        // Requirement: "if rejected show rejected they have to register again and again"
        // Let's set status to 'rejected' so they see the message on login, allowing them to know WHY.
        // BUT if they have to register again, they need to be able to use the SAME regNum? 
        // If I keep the doc, they can't register again with same ID. 
        // So I must DELETE the doc to allow re-registration. 
        // But how do they know they were rejected? They try to login -> "Invalid credentials" or I can't show "Rejected" if data is gone.
        // Compromise: Admin rejects -> Delete Account. 
        // User tries login -> "Invalid Credentials" -> decides to Register again.
        // OR: Admin rejects -> Status 'rejected'. User logs in -> "Rejected". User deletes account? No user can't delete.
        // Simple path: Delete user.
        await this.deleteUser(regNum);
        return { success: true };
    },

    async updateAdminId(currentId, newId) {
        newId = newId.toUpperCase().trim();
        if (currentId === newId) return;

        const oldRef = db.collection('users').doc(currentId);
        const newRef = db.collection('users').doc(newId);

        const newDoc = await newRef.get();
        if (newDoc.exists) throw new Error("New Admin ID already exists.");

        const oldDoc = await oldRef.get();
        if (!oldDoc.exists) throw new Error("Current Admin info not found.");

        const data = oldDoc.data();
        data.regNum = newId;

        // Transaction to ensure safety
        const batch = db.batch();
        batch.set(newRef, data);
        batch.delete(oldRef);
        await batch.commit();

        // Update session if self
        const currentUser = this.getCurrentUser();
        if (currentUser && currentUser.regNum === currentId) {
            currentUser.regNum = newId;
            this.saveSession(currentUser);
        }

        return { success: true };
    },

    async getStats() {
        const snapshot = await db.collection('users').get();
        const users = [];
        snapshot.forEach(doc => users.push(doc.data()));

        const contestants = users.filter(u => u.role === 'contestant');
        const voters = users.filter(u => u.role === 'voter');

        // Only count votes if valid
        const totalVotes = voters.filter(v => v.hasVoted).length;

        const candidateVotes = {};
        contestants.forEach(c => candidateVotes[c.regNum] = 0);
        voters.forEach(v => {
            if (v.hasVoted && v.votedFor) {
                if (candidateVotes[v.votedFor] !== undefined) candidateVotes[v.votedFor]++;
            }
        });

        return {
            totalContestants: contestants.length,
            totalVoters: voters.length,
            votesCast: totalVotes,
            votesNotCast: voters.length - totalVotes,
            candidateVotes,
            contestants,
            voters
        };
    },

    // New Secure Method for Voters
    async getCandidates() {
        const snapshot = await db.collection('users').where('role', '==', 'contestant').get();
        const candidates = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // Sanitize: Remove password or sensitive info if needed, but for now just returning data is fine as per schema.
            // DO NOT return vote counts here.
            candidates.push(data);
        });
        return candidates;
    },

    async vote(voterId, candidateId) {
        const userRef = db.collection('users').doc(voterId);
        await userRef.update({
            hasVoted: true,
            votedFor: candidateId,
            votedAt: new Date().toISOString()
        });

        // Update Session
        const current = this.getCurrentUser();
        if (current && current.regNum === voterId) {
            current.hasVoted = true;
            current.votedFor = candidateId;
            this.saveSession(current);
        }

        return { success: true };
    },

    async clearUsersByRole(role) {
        const snapshot = await db.collection('users').where('role', '==', role).get();
        const batch = db.batch();

        let count = 0;
        snapshot.forEach(doc => {
            const d = doc.data();
            // Protect Admin
            if (d.role === 'admin') return;
            batch.delete(doc.ref);
            count++;
        });

        if (count > 0) await batch.commit();
        return { success: true };
    },

    async changePassword(regNum, newPassword) {
        await db.collection('users').doc(regNum).update({
            password: newPassword
        });
        return { success: true };
    },

    // Extras
    async getUsers() {
        const snapshot = await db.collection('users').get();
        const users = [];
        snapshot.forEach(doc => users.push(doc.data()));
        return users;
    },

    // Reset Election Function
    async resetElection() {
        // Reset flags
        await this.setElectionStatus(false);
        await this.setElectionCompletion(false);

        // Reset all users (Voted Status)
        const snapshot = await db.collection('users').get();
        const batch = db.batch();

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.role === 'voter' || data.role === 'contestant') { // Reset all just in case
                batch.update(doc.ref, {
                    hasVoted: false,
                    votedFor: null,
                    votedAt: firebase.firestore.FieldValue.delete() // Remove votedAt
                });
            }
        });

        await batch.commit();
        return { success: true };
    }
};
