# Use the Node 18 base image
FROM node:18

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json files to install dependencies
COPY package*.json ./

# Install all necessary dependencies including geo-tz
RUN npm install

# Copy all the other project files to the container
COPY . .

# Set environment variables (you can adjust these as needed)
ENV PORT=8080
ENV GOOGLE_APPLICATION_CREDENTIALS=./gamedaydaily-b98a9-firebase-adminsdk-xjkcu-7aaff15be1.json
ENV DISCORD_TOKEN=c8af46286bc307c5221f34c4643c7718e22ae8c9b152386e38eb60b051ccce63
# Expose the port your app runs on
EXPOSE 8080

# Start the bot
CMD ["node", "bot.js"]
