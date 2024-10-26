require('dotenv').config(); // To load environment variables from a .env file
const axios = require('axios');
const puppeteer = require('puppeteer');
const Readability = require('@mozilla/readability').Readability;
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
console.log('OpenAI API key:', process.env.OPENAI_API_KEY);
const OpenAI = require('openai');
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
// Set up OpenAI API key

// Function to get the top three news article URLs from Bing News API
async function getTopNewsArticleUrls(query) {
  const apiKey = process.env.BING_NEWS_API_KEY;
  const encodedQuery = encodeURIComponent(query);
  const endpoint = `https://api.bing.microsoft.com/v7.0/search?q=${encodedQuery}&safeSearch=Moderate&category=Sports&sortBy=Relevance`;

  console.log('Endpoint:', endpoint);
  try {
      const response = await axios.get(endpoint, {
          headers: {
              'Ocp-Apim-Subscription-Key': apiKey
          }
      });

      const webPages = response.data.webPages;

      if (webPages && webPages.value && webPages.value.length > 0) {
          // Get the top three URLs
          const urls = webPages.value.slice(0, 3).map(item => item.url);
          return urls;
      } else {
          console.log('No web results found for the given query.');
          return [];
      }
  } catch (error) {
      console.error('Error fetching news articles:', error.response ? error.response.data : error.message);
      return [];
  }
}
// Function to scrape the main content of the article using Puppeteer and Readability.js
async function scrapeStory(url) {
  try {
      // Launch a headless browser
      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage({
        headless: false,
        args: ['--no-sandbox']
      });


      // Set a reasonable timeout
      await page.setDefaultNavigationTimeout(60000); // 60 seconds

      // Navigate to the URL
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('body')
      // Get the page content
      const content = await page.content();

      // Close the browser
      await browser.close();

      // Create a DOM environment
      const dom = new JSDOM(content, {
          url: url // Important for relative URLs
      });

      // Use Readability to parse the page
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article && article.textContent && article.textContent.trim().length > 0) {
          console.log('Title:', article.title);
          // console.log('Content:', article.textContent); // Optionally log the full content

          // Return the article content
          return article.textContent;
      } else {
          throw new Error('Could not extract article content.');
      }
  } catch (error) {
      console.error('Error scraping the story from URL:', url);
      console.error(error.message);
      throw error; // Propagate the error to the caller
  }
}
// Function to summarize text using OpenAI API
async function getGameDetails(gameInfo) {
	const prompt = `Give me important details in a paragraph format using only a one or two sentences about the following article: ${gameInfo}`;

	try {
		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					"role": "system",
					"content": [
						{
							"type": "text",
							"text": `
								You are an assisant.`
						}
					]
				},
				{
					"role": "user",
					"content": [
						{
							"type": "text",
							"text": prompt
						}
					]
				}
			]
	});
		console.log("OPENAI RESPONSE:", completion.choices[0].message);
    console.log("prompt_tokens:", completion.usage.prompt_tokens);
    console.log("completion_tokens:", completion.usage.completion_tokens);
    console.log("total_tokens:", completion.usage.total_tokens);
		return completion.choices[0].message;  // Get the generated text
	} catch (error) {
			console.error("Error getting game details from OpenAI:", error);
			return "Sorry, I couldn't get any interesting details about this game.";
	}
}
// Main function to tie everything together
// Main function to tie everything together
async function startGettingGameDetails(game_date) {
  // Replace this with your dynamic query
  const query = game_date;

  // Get the top three news article URLs
  const articleUrls = await getTopNewsArticleUrls(query);
  let article_we_used = "";
  if (articleUrls.length === 0) {
      console.log('No article URLs to scrape.');
      return "failed";
  }

  let scrapedContent = null;

  // Try scraping each URL up to three attempts
  for (let i = 0; i < articleUrls.length; i++) {
      const url = articleUrls[i];
      console.log(`Attempting to scrape URL ${i + 1}: ${url}`);
      try {
          scrapedContent = await scrapeStory(url);
          if (scrapedContent) {
              console.log('Successfully scraped content from:', url);
              article_we_used = url;
              break; // Exit the loop if scraping is successful
          }
      } catch (error) {
          console.log(`Failed to scrape URL ${i + 1}: ${url}`);
          // Continue to the next URL
      }
  }

  if (scrapedContent) {
      // Summarize the content using OpenAI API
      console.log('\n--- Summarizing the article ---\n');
      const summary = await getGameDetails(scrapedContent);
      if(summary.content){
        summary.url = `${article_we_used}`;
        return summary;
      }else{
        return summary;
      }
  } else {
      console.log('Failed to scrape any articles after three attempts.');
      return "failed";
  }
}


module.exports = {
  startGettingGameDetails
  // Add any other functions you need to export
};