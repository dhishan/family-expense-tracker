FROM node:20-alpine

# Install Java (required by Firebase emulators)
RUN apk add --no-cache openjdk11-jre curl

# Install Firebase CLI
RUN npm install -g firebase-tools@13

WORKDIR /firebase

# Copy Firebase config
COPY firebase.json .
COPY .firebaserc .
COPY firestore.rules .

EXPOSE 4000 8080 9099

HEALTHCHECK --interval=5s --timeout=5s --retries=20 --start-period=30s \
  CMD curl -f http://localhost:4000 || exit 1

CMD ["firebase", "emulators:start", "--only", "firestore,auth", "--project", "demo-family-expense-tracker"]
